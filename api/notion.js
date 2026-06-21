const NOTION_API = 'https://api.notion.com/v1';

const DB = {
  expenses: '2d3f0671-bf64-80a9-af04-c2057b3565c3',
  income: '2d3f0671-bf64-803b-adfd-fd86a90b46c7',
  budgetCategories: '1d7f0671-bf64-80e0-84dc-e51a1c302271',
  debtAccounts: '2d3f0671-bf64-802d-9d4f-c543e06669b7',
  savingsAccounts: '2d3f0671-bf64-80d2-9511-c0ad075003d1',
};

async function notionFetch(endpoint, method = 'GET', body = null) {
  const res = await fetch(`${NOTION_API}${endpoint}`, {
    method,
    headers: {
      'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: body ? JSON.stringify(body) : null,
  });
  return res.json();
}

async function queryDB(dbId, filter = null, sorts = null) {
  const body = {};
  if (filter) body.filter = filter;
  if (sorts) body.sorts = sorts;
  let results = [];
  let cursor = null;
  do {
    if (cursor) body.start_cursor = cursor;
    const data = await notionFetch(`/databases/${dbId}/query`, 'POST', body);
    results = results.concat(data.results || []);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return results;
}

async function getMonthData(year, month) {
  const m = String(month).padStart(2, '0');
  const startDate = `${year}-${m}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const endDate = `${year}-${m}-${String(lastDay).padStart(2, '0')}`;

  const [expenses, income] = await Promise.all([
    queryDB(DB.expenses, {
      and: [
        { property: 'Date', date: { on_or_after: startDate } },
        { property: 'Date', date: { on_or_before: endDate } },
      ]
    }),
    queryDB(DB.income, {
      and: [
        { property: 'Date', date: { on_or_after: startDate } },
        { property: 'Date', date: { on_or_before: endDate } },
      ]
    }),
  ]);

  let totalExpenses = 0;
  const expensesByCategory = {};
  const dailyTotals = {};

  for (const exp of expenses) {
    const p = exp.properties;
    const amount = p['Amount Spent']?.number || 0;
    const catRel = p['Budget Category Record 开销栏目']?.relation || [];
    const catId = catRel[0]?.id || 'other';
    const date = p['Date']?.date?.start?.slice(0, 10) || '';
    totalExpenses += amount;
    expensesByCategory[catId] = (expensesByCategory[catId] || 0) + amount;
    if (date) dailyTotals[date] = (dailyTotals[date] || 0) + amount;
  }

  let totalIncome = 0;
  for (const inc of income) {
    totalIncome += inc.properties['Amount Receive']?.number || 0;
  }

  return { totalExpenses, totalIncome, expensesByCategory, expenses, dailyTotals };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action, month, year } = req.query;

  try {
    if (action === 'dashboard') {
      const now = new Date();
      let targetYear, targetMonth;
      if (month) {
        [targetYear, targetMonth] = month.split('-').map(Number);
      } else {
        targetYear = now.getFullYear();
        targetMonth = now.getMonth() + 1;
      }

      const { totalExpenses, totalIncome, expensesByCategory, expenses, dailyTotals } = await getMonthData(targetYear, targetMonth);

      const [budgetCats, debtAccounts, savingsAccounts] = await Promise.all([
        queryDB(DB.budgetCategories),
        queryDB(DB.debtAccounts),
        queryDB(DB.savingsAccounts),
      ]);

      const budgetData = budgetCats.map(cat => {
        const p = cat.properties;
        const name = p['Category']?.title?.[0]?.plain_text || '';
        const rollup = p['Budget']?.rollup;
        const budget = rollup?.type === 'number' ? (rollup.number || 0)
          : rollup?.type === 'array' ? rollup.array.reduce((s, i) => s + (i.number || 0), 0)
          : 0;
        const actual = expensesByCategory[cat.id] || 0;
        return {
          name, budget, actual,
          variance: budget - actual,
          usage: budget > 0 ? Math.round((actual / budget) * 100) : 0,
        };
      }).filter(b => b.name && b.budget > 0);

      const debtData = debtAccounts.map(d => ({
        name: d.properties['Name']?.title?.[0]?.plain_text || '',
        remaining: d.properties['剩下债务']?.number || 0,
        monthlyPayment: d.properties['预期每个月偿还']?.number || 0,
        totalPaid: d.properties['总共偿还债务']?.rollup?.number || 0,
      }));

      const savingsData = savingsAccounts.map(s => ({
        name: s.properties['Name']?.title?.[0]?.plain_text || '',
        monthlyTarget: s.properties['每月储蓄目标']?.number || 0,
        accumulated: s.properties['累积储蓄情况']?.rollup?.number || 0,
        purpose: s.properties['户口储蓄用途']?.rich_text?.[0]?.plain_text || '',
      }));

      const totalDebt = debtData.reduce((s, d) => s + d.remaining, 0);
      const totalSavings = savingsData.reduce((s, d) => s + d.accumulated, 0);
      const totalBudget = budgetData.reduce((s, d) => s + d.budget, 0);
      const savingsRate = totalIncome > 0 ? Math.round(((totalIncome - totalExpenses) / totalIncome) * 100) : 0;
      const budgetAdherence = totalBudget > 0 ? Math.round((totalExpenses / totalBudget) * 100) : 0;

      const recentExpenses = expenses
        .sort((a, b) => new Date(b.properties['Date']?.date?.start) - new Date(a.properties['Date']?.date?.start))
        .slice(0, 5)
        .map(e => ({
          name: e.properties['Expenses']?.title?.[0]?.plain_text || '',
          amount: e.properties['Amount Spent']?.number || 0,
          date: e.properties['Date']?.date?.start || '',
          category: e.properties['Budget Category Record 开销栏目']?.relation?.[0] ? budgetCats.find(c => c.id === e.properties['Budget Category Record 开销栏目'].relation[0].id)?.properties['Category']?.title?.[0]?.plain_text || '' : '',
        }));

      return res.json({
        overview: { totalSavings, totalDebt, netWorth: totalSavings - totalDebt },
        monthly: { income: totalIncome, expenses: totalExpenses, savingsRate, budgetAdherence, month: `${targetYear}年${String(targetMonth).padStart(2,'0')}月`, year: targetYear, monthNum: targetMonth },
        budget: budgetData,
        debt: debtData,
        savings: savingsData,
        recentExpenses,
        daily: dailyTotals,
      });
    }

    if (action === 'yearly') {
      const targetYear = parseInt(year) || new Date().getFullYear();
      const now = new Date();
      const maxMonth = targetYear === now.getFullYear() ? now.getMonth() + 1 : 12;
      const monthNames = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
      const months = [];

      for (let m = 1; m <= maxMonth; m++) {
        const { totalExpenses, totalIncome } = await getMonthData(targetYear, m);
        months.push({
          month: monthNames[m - 1],
          expenses: totalExpenses,
          income: totalIncome,
          savingsRate: totalIncome > 0 ? Math.round(((totalIncome - totalExpenses) / totalIncome) * 100) : 0,
        });
      }

      return res.json({ year: targetYear, months });
    }

    if (action === 'categories') {
      const cats = await queryDB(DB.budgetCategories);
      return res.json(cats.map(c => ({
        id: c.id,
        name: c.properties['Category']?.title?.[0]?.plain_text || '',
      })).filter(c => c.name));
    }

    if (action === 'debt-accounts') {
      const accounts = await queryDB(DB.debtAccounts);
      return res.json(accounts.map(a => ({
        id: a.id,
        name: a.properties['Name']?.title?.[0]?.plain_text || '',
        remaining: a.properties['剩下债务']?.number || 0,
      })));
    }

    if (req.method === 'POST' && action === 'add-expense') {
      const { name, amount, categoryId, date } = req.body;
      await notionFetch('/pages', 'POST', {
        parent: { database_id: DB.expenses },
        properties: {
          'Expenses': { title: [{ text: { content: name } }] },
          'Amount Spent': { number: parseFloat(amount) },
          'Date': { date: { start: date } },
          ...(categoryId ? { 'Budget Category Record 开销栏目': { relation: [{ id: categoryId }] } } : {}),
        }
      });
      return res.json({ success: true });
    }

    if (req.method === 'POST' && action === 'add-income') {
      const { name, amount, category, date, remarks } = req.body;
      await notionFetch('/pages', 'POST', {
        parent: { database_id: DB.income },
        properties: {
          'Income': { title: [{ text: { content: name } }] },
          'Amount Receive': { number: parseFloat(amount) },
          'Date': { date: { start: date } },
          'Income Category': { select: { name: category } },
          ...(remarks ? { 'Remarks': { rich_text: [{ text: { content: remarks } }] } } : {}),
        }
      });
      return res.json({ success: true });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}

import { db } from './db.js';

// N+1 query problem
async function getWeeklyMeals(userId) {
  const days = await db.query('SELECT * FROM days WHERE user_id = ?', [userId]);
  
  const result = [];
  // N+1: fetching meals for each day separately
  for (const day of days) {
    const meals = await db.query('SELECT * FROM meals WHERE day_id = ?', [day.id]);
    // N+1 squared: fetching nutrition for each meal
    for (const meal of meals) {
      const nutrition = await db.query('SELECT * FROM nutrition WHERE meal_id = ?', [meal.id]);
      meal.nutrition = nutrition[0];
    }
    result.push({ ...day, meals });
  }
  return result;
}

// Loading all users into memory
async function getMostPopularMeals() {
  const users = await db.query('SELECT * FROM users');  // loads ALL users!
  const mealCounts = {};
  
  for (const user of users) {
    const meals = await db.query('SELECT * FROM meals WHERE user_id = ?', [user.id]);
    for (const meal of meals) {
      mealCounts[meal.name] = (mealCounts[meal.name] || 0) + 1;
    }
  }
  
  return Object.entries(mealCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));
}

// Synchronous blocking in async code
async function processLargeMealPlan(planId) {
  const plan = await db.query('SELECT * FROM meal_plans WHERE id = ?', [planId]);
  
  let csvContent = 'day,meal,calories
';
  for (const entry of plan[0].entries) {
    // Busy wait - blocks event loop
    const start = Date.now();
    while (Date.now() - start < 1) {}
    csvContent += entry.day + ',' + entry.meal + ',' + entry.calories + '
';
  }
  return csvContent;
}

export { getWeeklyMeals, getMostPopularMeals, processLargeMealPlan };


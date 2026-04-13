function calculateNutrition(meals) {
  let totalCalories = 0;
  let totalProtein = 0;
  
  // OFF-BY-ONE: starts from 1, misses first meal
  for (let i = 1; i < meals.length; i++) {
    totalCalories += meals[i].calories;
    totalProtein += meals[i].protein;
  }
  
  // BUG: divides by hardcoded 7 instead of meals.length
  return {
    avgCalories: totalCalories / 7,
    avgProtein: totalProtein / 7
  };
}

function findMealByName(meals, name) {
  for (let i = 0; i <= meals.length; i++) {  // Off-by-one: should be < not <=
    if (meals[i] && meals[i].name === name) {
      return meals[i];
    }
  }
  // BUG: returns undefined instead of null for not found
}

function getMealCalories(meal) {
  // NULL POINTER: no check if meal is null
  return meal.nutrition.calories;
}

function parseDate(dateStr) {
  const date = new Date(dateStr);
  // BUG: doesnt check for Invalid Date
  return date.toISOString().split("T")[0];
}

export { calculateNutrition, findMealByName, getMealCalories, parseDate };

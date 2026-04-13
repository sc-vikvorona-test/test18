/**
 * Well-written meal validation utilities
 * Testing for false positives - this code should be clean
 */

/**
 * Validates a meal object has required fields
 * @param {Object} meal - Meal to validate
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateMeal(meal) {
  const errors = [];
  
  if (!meal || typeof meal !== 'object') {
    return { valid: false, errors: ['Meal must be an object'] };
  }
  
  if (!meal.name || typeof meal.name !== 'string' || meal.name.trim().length === 0) {
    errors.push('Meal name is required');
  }
  
  if (meal.name && meal.name.length > 100) {
    errors.push('Meal name must be 100 characters or less');
  }
  
  if (meal.calories !== undefined) {
    if (typeof meal.calories !== 'number' || meal.calories < 0) {
      errors.push('Calories must be a non-negative number');
    }
  }
  
  return { valid: errors.length === 0, errors };
}

/**
 * Safely calculates average calories per meal
 * @param {Array} meals - Array of meal objects
 * @returns {number} Average calories, or 0 if no meals
 */
export function averageCalories(meals) {
  if (!Array.isArray(meals) || meals.length === 0) {
    return 0;
  }
  
  const total = meals.reduce((sum, meal) => {
    return sum + (meal.calories || 0);
  }, 0);
  
  return Math.round(total / meals.length);
}

/**
 * Groups meals by category
 * @param {Array} meals - Array of meal objects with category field
 * @returns {Object} Meals grouped by category
 */
export function groupByCategory(meals) {
  if (!Array.isArray(meals)) {
    return {};
  }
  
  return meals.reduce((groups, meal) => {
    const category = meal.category || 'uncategorized';
    if (!groups[category]) {
      groups[category] = [];
    }
    groups[category].push(meal);
    return groups;
  }, {});
}


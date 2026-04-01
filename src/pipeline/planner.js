const { hermesPlan } = require('../hermes/index');
const { db, updateGoal, createFloor, addLog } = require('../db');

/**
 * Run Hermes/Elira planner to decompose a goal into floors.
 * Creates floor records in DB and updates goal status.
 * @param {Object} goal - goal record from DB
 * @returns {Promise<Array>} created floor records
 */
async function runPlanner(goal) {
  console.log(`[Planner] Starting for goal: ${goal.id}`);
  addLog(goal.id, null, 'Hermes', 'Starting building planner...');

  try {
    const floorPlans = await hermesPlan(goal.text, { goalId: goal.id });

    const createPlan = db.transaction(() => {
      updateGoal(goal.id, { building_plan: JSON.stringify(floorPlans), status: 'building' });
      const floors = [];
      for (let i = 0; i < floorPlans.length; i++) {
        const fp = floorPlans[i];
        const floor = createFloor(goal.id, i + 1, fp.name, fp.description, fp.successCondition, fp.deliverable);
        floors.push(floor);
      }
      return floors;
    });

    const floors = createPlan();

    addLog(goal.id, null, 'Hermes', `Plan complete: ${floors.length} floors created`);
    console.log(`[Planner] Created ${floors.length} floors for goal ${goal.id}`);
    return floors;
  } catch (err) {
    console.error(`[Planner] Failed:`, err.message);
    updateGoal(goal.id, { status: 'blocked' });
    addLog(goal.id, null, 'Hermes', `Planning failed: ${err.message}`);
    throw err;
  }
}

module.exports = { runPlanner };

// D:\AI_Projects\xbot\backend\lib\engine-state.js
let isArmed = false;

module.exports = {
  getArmed: () => isArmed,
  setArmed: (val) => {
    isArmed = !!val;
  }
};

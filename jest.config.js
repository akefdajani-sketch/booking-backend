module.exports = {
  testEnvironment: "node",
  transform: {
    "^.+\\.[jt]sx?$": "babel-jest",
  },
  // ✅ remove testRunner completely
};

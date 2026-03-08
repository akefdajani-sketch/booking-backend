module.exports = {
  testEnvironment: "node",
  transform: {
    "^.+\\.[jt]sx?$": "babel-jest",
  },
  // PR-6: Coverage collection
  collectCoverageFrom: [
    "routes/**/*.js",
    "middleware/**/*.js",
    "utils/**/*.js",
    "!utils/algolia/**",
    "!**/*.test.js",
  ],
  coverageThreshold: {
    global: {
      lines:     70,
      functions: 65,
      branches:  55,
      statements: 70,
    },
  },
  coverageReporters: ["text-summary", "lcov"],
};

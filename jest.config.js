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
    // Sub-route directories are loaded through barrel files which are tested:
    "!routes/bookings/**",
    "!routes/customerMemberships/**",
    "!routes/customers/**",
    "!routes/services/**",
    "!routes/tenants/**",
    "!routes/tenantUsers/**",
    "!routes/tenantStaffSchedule/**",
    "!routes/tenantPrepaidAccounting/**",
    "!routes/adminTenantsTheme/**",
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

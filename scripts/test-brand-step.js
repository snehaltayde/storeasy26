// P6-BRAND suite (GEN-04): the brand step, extended by P6-START-UI.
// Registered by P6-FIXTURE so the gate has its suites from phase 6 batch 1 (102
// suites). P6-BRAND replaces this file with the real suite.
//   pnpm test:brand-step
// Fixture stores set checkout_mode themselves: never depend on the env.
delete process.env.CHECKOUT_MODE;
console.log("placeholder: filled by P6-BRAND");
process.exit(0);

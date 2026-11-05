// P6-OPEN suite (PUB-12): Before you open your store.
// Registered by P6-FIXTURE so the gate has its suites from phase 6 batch 1 (102
// suites). P6-OPEN replaces this file with the real suite.
//   pnpm test:open-checks
// Fixture stores set checkout_mode themselves: never depend on the env.
delete process.env.CHECKOUT_MODE;
console.log("placeholder: filled by P6-OPEN");
process.exit(0);

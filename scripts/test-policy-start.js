// P6-POLICY-START suite (GEN-06, partly; plan revision 4): the policy starters.
// Registered by P6-FIXTURE so the gate has its suites from phase 6 batch 1 (102
// suites). P6-POLICY-START replaces this file with the real suite.
//   pnpm test:policy-start
// Fixture stores set checkout_mode themselves: never depend on the env.
delete process.env.CHECKOUT_MODE;
console.log("placeholder: filled by P6-POLICY-START");
process.exit(0);

// Client-safe. After Razorpay reports success the customer has paid, so a failure
// to record that isn't theirs to resolve: keep asking the server (the signed
// payload can be resent safely) and end as "pending", never as a payment error.
// Only a definite refusal from the server ends as "rejected".
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];

export async function confirmPayment(post, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), delays = RETRY_DELAYS_MS } = {}) {
  let confirmationPath;
  for (let attempt = 0; ; attempt++) {
    const res = await post().catch(() => null); // the network itself can be the blip
    if (res?.data?.ok) return { state: "confirmed", data: res.data };
    const retryable = !res || res.status >= 500 || res.status === 429 || res.data?.pending;
    if (!retryable) return { state: "rejected", error: res.data?.error || "Payment verification failed" };
    confirmationPath = res?.data?.confirmationPath || confirmationPath;
    if (attempt >= delays.length) return { state: "pending", confirmationPath };
    await sleep(delays[attempt]);
  }
}

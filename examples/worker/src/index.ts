/**
 * Deploy the facilitator from your own Worker project, with the package as a dependency (no fork needed).
 * Re-export both: the default fetch handler routes every request to the RailPayFacilitator Durable Object.
 *
 * Put your own routes in front by wrapping `worker.fetch` before delegating to it.
 */
export { default, RailPayFacilitator } from "railpay-facilitator/worker";

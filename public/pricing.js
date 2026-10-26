// Workers Paid plan allowances and overage prices (USD), checked 16 Oct 2026 against
// https://developers.cloudflare.com/workers/platform/pricing/
// https://developers.cloudflare.com/r2/pricing/
// https://developers.cloudflare.com/workers-ai/platform/pricing/
// Prices change: update this file (and PRICES_CHECKED) when Cloudflare's pages do.

export const PRICES_CHECKED = "16 Oct 2026";
export const BASE_FEE = 5;

const M = 1e6;
export const GB = 2 ** 30;

// kind: "usage" accrues over the billing period and resets with it; "storage" is billed per GB-month
// (shown as the current amount); "daily" resets every day at 00:00 UTC.
export const ALLOWANCES = [
  { id: "workers.requests", product: "Workers", label: "Requests", unit: "count", kind: "usage", included: 10 * M, price: 0.3 / M },
  { id: "workers.cpu", product: "Workers", label: "CPU time", unit: "ms", kind: "usage", included: 30 * M, price: 0.02 / M },

  { id: "do.requests", product: "Durable Objects", label: "Requests", unit: "count", kind: "usage", included: 1 * M, price: 0.15 / M },
  { id: "do.duration", product: "Durable Objects", label: "Duration", unit: "gbs", kind: "usage", included: 400_000, price: 12.5 / M },
  { id: "do.rowsRead", product: "Durable Objects", label: "SQLite rows read", unit: "count", kind: "usage", included: 25e9, price: 0.001 / M },
  { id: "do.rowsWritten", product: "Durable Objects", label: "SQLite rows written", unit: "count", kind: "usage", included: 50 * M, price: 1 / M },
  { id: "do.sqlStorage", product: "Durable Objects", label: "SQLite storage", unit: "bytes", kind: "storage", included: 5 * GB, price: 0.2 / GB },
  { id: "do.kvReads", product: "Durable Objects", label: "KV storage read units", unit: "count", kind: "usage", included: 1 * M, price: 0.2 / M },
  { id: "do.kvWrites", product: "Durable Objects", label: "KV storage write units", unit: "count", kind: "usage", included: 1 * M, price: 1 / M },
  { id: "do.kvDeletes", product: "Durable Objects", label: "KV storage deletes", unit: "count", kind: "usage", included: 1 * M, price: 1 / M },
  { id: "do.kvStorage", product: "Durable Objects", label: "KV storage", unit: "bytes", kind: "storage", included: 1 * GB, price: 0.2 / GB },

  { id: "d1.rowsRead", product: "D1", label: "Rows read", unit: "count", kind: "usage", included: 25e9, price: 0.001 / M },
  { id: "d1.rowsWritten", product: "D1", label: "Rows written", unit: "count", kind: "usage", included: 50 * M, price: 1 / M },
  { id: "d1.storage", product: "D1", label: "Storage", unit: "bytes", kind: "storage", included: 5 * GB, price: 0.75 / GB },

  { id: "kv.reads", product: "Workers KV", label: "Reads", unit: "count", kind: "usage", included: 10 * M, price: 0.5 / M },
  { id: "kv.writes", product: "Workers KV", label: "Writes", unit: "count", kind: "usage", included: 1 * M, price: 5 / M },
  { id: "kv.deletes", product: "Workers KV", label: "Deletes", unit: "count", kind: "usage", included: 1 * M, price: 5 / M },
  { id: "kv.lists", product: "Workers KV", label: "Lists", unit: "count", kind: "usage", included: 1 * M, price: 5 / M },
  { id: "kv.storage", product: "Workers KV", label: "Storage", unit: "bytes", kind: "storage", included: 1 * GB, price: 0.5 / GB },

  { id: "r2.classA", product: "R2", label: "Class A operations", unit: "count", kind: "usage", included: 1 * M, price: 4.5 / M },
  { id: "r2.classB", product: "R2", label: "Class B operations", unit: "count", kind: "usage", included: 10 * M, price: 0.36 / M },
  { id: "r2.storage", product: "R2", label: "Storage (Standard)", unit: "bytes", kind: "storage", included: 10 * GB, price: 0.015 / GB },
  // Infrequent Access has no free tier.
  { id: "r2.iaClassA", product: "R2", label: "Infrequent Access class A", unit: "count", kind: "usage", included: 0, price: 9 / M },
  { id: "r2.iaClassB", product: "R2", label: "Infrequent Access class B", unit: "count", kind: "usage", included: 0, price: 0.9 / M },
  { id: "r2.iaStorage", product: "R2", label: "Storage (Infrequent Access)", unit: "bytes", kind: "storage", included: 0, price: 0.01 / GB },

  { id: "queues.operations", product: "Queues", label: "Operations", unit: "count", kind: "usage", included: 1 * M, price: 0.4 / M },

  { id: "ai.neurons", product: "Workers AI", label: "Neurons today", unit: "count", kind: "daily", included: 10_000, price: 0.011 / 1000 },
];

// R2 operation classes, from the R2 pricing page. Anything unlisted is classed by its verb.
const R2_CLASS_A = new Set(["ListBuckets", "PutBucket", "ListObjects", "PutObject", "CopyObject", "CompleteMultipartUpload", "CreateMultipartUpload", "LifecycleStorageTierTransition", "ListMultipartUploads", "UploadPart", "UploadPartCopy", "ListParts", "PutBucketEncryption", "PutBucketCors", "PutBucketLifecycleConfiguration"]);
const R2_CLASS_B = new Set(["HeadBucket", "HeadObject", "GetObject", "UsageSummary", "GetBucketEncryption", "GetBucketLocation", "GetBucketCors", "GetBucketLifecycleConfiguration"]);
const R2_FREE = new Set(["DeleteObject", "DeleteBucket", "AbortMultipartUpload"]);

export function r2Class(action) {
  if (R2_CLASS_A.has(action)) return "A";
  if (R2_CLASS_B.has(action)) return "B";
  if (R2_FREE.has(action)) return "free";
  if (/^(Delete|Abort)/.test(action)) return "free";
  if (/^(Get|Head)/.test(action)) return "B";
  return "A";
}

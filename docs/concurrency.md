# Concurrency and operational recovery

## Financial invariant

For each trip, `0 <= sum(valid payments) <= totalAmountPaise`. All financial mutations follow this protocol:

1. Read the owner-scoped trip and its `revision`.
2. Check idempotency, amounts, history limits and business conditions against that snapshot.
3. Update using `{_id, ownerId, revision}` and increment the revision in the same atomic write. Append the audit event in that write.
4. Payment mutations retry from a fresh snapshot after a definite revision miss (up to 20 attempts). Trip patches return 409 so a stale user edit is reviewed again.

Creation also checks `'payments.idempotencyKey': {$ne: key}` in the update predicate. This is a single-document condition, not a unique multikey index. Duplicate keys inside a payment array cannot be prevented by a unique multikey index. Ledger entries and audit events are never deleted. An ambiguous network result is safe to retry using the same payment idempotency key.

These choices follow MongoDB's [single-document atomicity and expected-value update guidance](https://www.mongodb.com/docs/v8.0/core/write-operations-atomicity/) and [unique multikey index semantics](https://www.mongodb.com/docs/manual/core/indexes/index-types/index-multikey/).

## Booking invariant

Each noncancelled trip must have a matching reservation token on its vehicle. Every reservation blocks other trip IDs over `[startAt, endAt)`. A vehicle update atomically checks that no other-trip interval satisfies `existing.startAt < requested.endAt AND existing.endAt > requested.startAt`, checks active status and the reservation capacity, and appends the new token. This single document serializes conflicting reservations from every API process.

On creation, reserve first, then insert the trip. On rescheduling or vehicle reassignment, reserve the new interval first while the old reservation still exists, write the trip using its expected revision, and only then remove the exact old token. Same-trip reservations may overlap so edits can retain both intervals temporarily. A definite revision miss releases only the new token owned by that unsuccessful operation. An uncertain result retains it. Cancellation first updates the trip status and audit, then removes the previous reservation.

This provides strict exclusion but not all-or-nothing multi-document writes. A server crash, disconnected client/database, duplicate import race, or failed validation after reservation can leave a token that no current trip references. That token continues blocking bookings. The system prefers a visible availability conflict over an undetected double booking. Never add time-based expiration or background lease cleanup: a paused writer could resume after cleanup and invalidate the guarantee.

The maximum is 5,000 reservations per vehicle, including historical and retained tokens. Most vehicles can retain many years of trips within this bound. The API returns an explicit conflict at capacity. Do not prune completed reservations casually: that would allow later creation of overlapping historical trips. A larger deployment needs a designed history/booking partition strategy.

## Read-only inspection and manual recovery

Run `npm.cmd run bookings:inspect` against the intended database. It reports reservations with missing trips or tokens different from the trip's currently referenced token. This command does not create indexes, remove reservations or modify trips. It is an administrator command with access to all owners in that configured database.

To recover a retained reservation:

1. Stop **all** API instances and any import/seed writers. Verify no background writer can resume. Take a backup.
2. Inspect the reported vehicle, token, trip ID, owner and interval alongside the stored trip. A report from a running system is only a candidate; an in-flight writer may still own it.
3. If the trip references the token, keep it. If a noncancelled trip lacks its correct reservation, restore that protection before accepting any bookings. Investigate any manual database edits.
4. Only after confirming that no current noncancelled trip depends on the candidate token, an administrator can remove that **specific** token using an owner- and vehicle-scoped `$pull`. Never clear an entire reservation array.
5. Rerun inspection, review affected trips, then restart writers.

There is deliberately no automatic destructive repair endpoint. Application code and CLI writers must use the reservation protocol; direct manual inserts can bypass any application invariant. This implementation requires no replica set. If future requirements demand atomic cleanup and all-or-nothing writes across vehicle/trip documents, plan a separately reviewed replica-set migration and transaction-based booking protocol. No existing service settings are altered by this project.

## Durability and scope

Writes request journal acknowledgment (`w: 1, j: true`) on the detected standalone server. This protects process-crash recovery but cannot substitute for database backups or replicated failover. Read/modify/replace without a revision guard is prohibited for trip financial fields. Server-side ownership filters are applied to every API read and mutation; owner IDs cannot be supplied in request bodies.

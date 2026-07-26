---
title: "Phone HTTP response metadata uses a flat envelope"
type: lesson
products: [hitl-channel, hitl-app]
source: hitl-channel#38
task_id: d5811fc0-cbdf-4793-a8bb-823cd1d3abfb
last_updated: 2026-07-26
---

## What happened

The `questions_batch_response` formatter added by hitl-channel#22 read only
`body.metadata`. The hitl-app client has always flattened message metadata into
the top-level HTTP `POST /` body, so live batch replies carried `type`,
`batch_id`, and `batch_answer` beside `content` and never entered the formatter
or the questions-batch audit branch.

## Lesson

Tests for phone-to-channel HTTP messages must use the client's real serialized
wire envelope, not a hand-authored domain-model shape. The bridge now normalizes
supported flat response fields when nested `metadata` is absent while retaining
backward compatibility with nested senders. Regression fixtures should include
the same top-level `id` and `timestamp` fields emitted by hitl-app so future
contract drift is visible.

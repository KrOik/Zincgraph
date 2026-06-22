# Optional headless agent A/B extension

This repository's local benchmark is deterministic and does not require paid agent credentials. To evaluate true agent effects, extend the existing upstream CodeGraph benchmark shape from `refer/codegraph/scripts/agent-eval/`.

## Recommended arms

1. `none`: empty MCP config; agent can only use native Read/Grep/Bash.
2. `codegraph`: CodeGraph MCP server.
3. `zincgraph-graph`: Zincgraph MCP with prompts emphasizing graph-delegated tools.
4. `zincgraph-fusion`: Zincgraph MCP with semantic/fusion tools emphasized.
5. `zincgraph-full`: Zincgraph MCP plus freshness/review/dedup task prompts where applicable.

## Metrics

Reuse upstream parser concepts:

- wall-clock duration,
- total tokens processed,
- total cost,
- total tool calls,
- Read/Grep/Bash calls,
- CodeGraph/Zincgraph tool calls,
- answer quality rubric score,
- citation correctness,
- hallucination or unsupported-claim count.

## Suggested rubric additions

For each repo/question, define:

- must-reference files,
- must-mention concepts,
- expected call-path edges,
- forbidden hallucinations,
- score out of 10 for correctness/evidence/completeness.

Judge answers blind to the arm label. Local deterministic results from `bench/compare.mjs` should be treated as preflight evidence, not a substitute for this agent A/B suite.

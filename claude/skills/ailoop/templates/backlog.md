# Backlog — <project>

The loop's driver. Ordered, dependency-aware ticket queue. The coordinator works
this file: pull the next **ready** ticket (all `depends_on` are `done`), dispatch
it to a fresh subagent, verify its `acceptance`, update status. Append-mostly —
never delete a ticket; mark it `done` or `decomposed`.

`status`: `todo` → `ready` → `in-progress` → `done` | `blocked` | `decomposed`
Ready = every `depends_on` ticket is `done`. Ready tickets with disjoint `files`
may fan out in parallel worktrees; tickets sharing files serialize.

---

<!-- TICKET TEMPLATE — copy per ticket. Keep context self-contained: a subagent
     that has never seen the planning conversation must be able to run it. -->

### T001 — <one-line title>
- **status:** ready
- **depends_on:** []
- **files:** [path/a.ts, path/b.ts]        # expected touch set → parallelism key
- **origin:** spec §X.Y                      # or "decomposed from T0NN"
- **context:** |
    Everything the subagent needs and nothing it doesn't:
    - which spec sections govern this (quote the binding constraints)
    - which locked decisions apply (cite oracle.md)
    - what already exists (which prior tickets built what it depends on)
    - the precise deliverable — build only this
- **acceptance:** |
    The ticket-local oracle — checkable, not vibes:
    - `<command>` exits 0
    - `<behavioral check with expected result>`
- **evidence:**                              # filled on completion — real output, not claims

---

## Queue

<!-- tickets in dependency order; earliest-ready at top -->

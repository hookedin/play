# Project design constraint

Absolute simplicity is always a priority. Unneeded complexity must never creep in.

This is a pure prototype, called v1. There are no backward compatibility or
migration requirements. Freely change contracts, signed structures, APIs, storage
schemas and game formats when doing so simplifies or improves the current design.
Delete obsolete fields and paths instead of reserving them or adding compatibility
layers. Existing prototype deployments and data are disposable; a version label
is not a compatibility promise. Optimize the current contract while preserving
the explicitly advertised guarantees and accepted trust assumptions.

Use the smallest correct change that meets the current requirement. Reuse existing
state, validation and recovery paths. Do not add speculative abstractions, duplicate
sources of truth, extra authorities, services or configuration without a concrete
need. Remove obsolete paths when replacing them.

Keep the guarantees we advertise correct and testable. Preserve explicitly accepted
trust assumptions and manual responsibilities; do not expand the protocol merely to
offer stronger guarantees. Explain any necessary added complexity and why a simpler
approach cannot meet the requirement. See [architecture.md](architecture.md).

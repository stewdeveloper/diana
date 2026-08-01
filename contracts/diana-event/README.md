# Diana event contract

`packages/diana-core/src/core/eventTypes.ts` is the only source of truth. The
JSON metadata and TypeScript declaration beside this file are generated for
consumers such as Meeps:

```sh
npm run contract:generate
```

CI runs `npm run contract:check` and fails if either generated file is stale.
Consumers copy both generated files together and use the JSON `eventTypes` at
runtime and the declaration during type checking.

## Adding an event type

1. Add the discriminator to `DIANA_EVENT_TYPES` and its variant to
   `DianaEvent`, but do not emit the new event yet.
2. Generate and commit the contract, then update and deploy Meeps with those
   generated files. Meeps deliberately returns 400 for an unknown type, so it
   must understand the discriminator before Diana sends it.
3. In a following Diana change, enable emission of the new event.

For a breaking envelope or payload change, first make Meeps accept both the old
and new versions. Then bump `DIANA_EVENT_SCHEMA_VERSION`, deploy Diana, and only
afterwards remove old-version support from Meeps.

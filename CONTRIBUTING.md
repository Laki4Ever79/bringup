# Contributing

Contributions are welcome under the Apache-2.0 licence ([LICENSE](LICENSE)).

1. Set up as the [README](README.md#install--run) says, then run a scripted design: `npm run bringup -- briefs/rover.md --mock`.
2. Make your change on a branch. Keep generated files generated: change the code that writes them.
3. Run the tests your change touches (`npm run test:affected -- --run`) and `npm run typecheck`; a mock run of a brief
   (`--mock`) is the end-to-end check for anything an agent or a builder does.
4. Open a pull request saying what changed and what you measured, before and after.

Every command and the test layout are in [docs/details.md](docs/details.md).

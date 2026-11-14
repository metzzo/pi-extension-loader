# Releasing

1. Confirm the working tree is clean and the intended commit is checked out.
2. Confirm `https://github.com/metzzo/pi-extension-loader` exists, is public, and is configured as `origin`.
3. Confirm the npm package name is still available or owned by the publisher:

   ```bash
   npm view pi-extension-reloader
   ```

4. Update the version and `CHANGELOG.md` together.
5. Install exactly the locked development dependencies and run the deterministic release gate:

   ```bash
   npm ci
   npm run release:check
   ```

6. Source an isolated Pi environment and run the authenticated GPT-6.1-Sol-low end-to-end test on both supported versions:

   ```bash
   npm run test:e2e
   ```

7. Inspect the exact tarball and perform an npm dry run:

   ```bash
   npm pack --dry-run
   npm publish --dry-run
   ```

8. Publish and verify installation through Pi:

   ```bash
   npm publish
   pi install npm:pi-extension-reloader@<version>
   ```

9. Tag the release commit with `v<version>` and publish matching GitHub release notes.

Never publish from a dirty working tree or include local Pi credentials, state, or test artifacts.

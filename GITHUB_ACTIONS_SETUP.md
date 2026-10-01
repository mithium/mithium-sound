# GitHub Actions Setup for Mithium Sound v1.7.0

## ✅ Completed Steps

1. ✅ Created `.github/workflows/release.yml` with:
   - Triggers on version tags (`v*`) and manual workflow_dispatch
   - Builds on `windows-latest`
   - Installs dependencies and runs `npm run build`
   - Creates GitHub Releases with NSIS installer and electron-updater files
   
2. ✅ Merged PR #2: https://github.com/mithium/mithium-sound/pull/2

3. ✅ Created and pushed tag `v1.7.0`

## ⚠️ Required: Enable GitHub Actions

The workflow is ready but needs GitHub Actions to be enabled on the repository.

### Steps to Enable Actions:

1. Go to: https://github.com/mithium/mithium-sound/actions

2. If you see a "Get started with GitHub Actions" page or an "Enable Actions" button:
   - Click **"I understand my workflows, go ahead and enable them"** or similar button
   - GitHub Actions will be enabled for the repository

3. Once enabled, the workflow should automatically run for the existing `v1.7.0` tag
   - If it doesn't auto-run, you can manually trigger it:
     - Go to: https://github.com/mithium/mithium-sound/actions/workflows/release.yml
     - Click "Run workflow" → Select "main" branch → Click "Run workflow"

4. Monitor the workflow run at: https://github.com/mithium/mithium-sound/actions

### Expected Artifacts

Once the workflow completes successfully, check the release at:
https://github.com/mithium/mithium-sound/releases/tag/v1.7.0

You should see:
- ✅ `Mithium Sound-Setup-1.7.0.exe` - NSIS installer
- ✅ `Mithium Sound-1.7.0-win.zip` - Portable zip
- ✅ `latest.yml` - electron-updater configuration
- ✅ `.blockmap` files - Update delta files

### Troubleshooting

If the workflow doesn't trigger after enabling Actions:
1. Manually run the workflow from the Actions tab (see step 3 above)
2. Or delete and re-push the tag:
   ```bash
   git tag -d v1.7.0
   git push origin :refs/tags/v1.7.0
   git tag v1.7.0
   git push origin v1.7.0
   ```

## Workflow Details

The workflow (`release.yml`) will:
1. Checkout the repository
2. Setup Node.js 20 with npm caching
3. Run `npm ci` to install dependencies
4. Run `npm run build` to create the installer
5. Upload all build artifacts to the GitHub Release

Build time: ~5-10 minutes on GitHub-hosted Windows runners.

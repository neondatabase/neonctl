const path = require('path');

module.exports = {
  // resolves from test to snapshot path
  resolveSnapshotPath: (testPath, snapshotExtension) => {
    const p = path.relative(__dirname, testPath);
    const parts = p.split(path.sep);
    parts[0] = 'snapshots';
    parts[parts.length - 1] = parts[parts.length - 1].replace(
      '.js',
      snapshotExtension
    );
    const r = path.join(__dirname, ...parts);
    return r;
  },

  // resolves from snapshot to test path
  resolveTestPath: (snapshotFilePath, snapshotExtension) => {
    const p = path.relative(__dirname, snapshotFilePath);
    const parts = p.split(path.sep);
    parts[0] = 'dist';
    parts[parts.length - 1] = parts[parts.length - 1].replace(
      snapshotExtension,
      '.js'
    );
    const r = path.join(__dirname, ...parts);
    return r;
  },

  // Example test path, used for preflight consistency check of the implementation above
  testPathForConsistencyCheck: `${__dirname}/dist/example.test.js`,
};

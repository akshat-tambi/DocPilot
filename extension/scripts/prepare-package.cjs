#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const extensionRoot = path.resolve(__dirname, '..');
const runtimeRoot = path.join(extensionRoot, 'runtime');
const workerDist = path.resolve(extensionRoot, '..', 'worker', 'dist');
const sharedDist = path.resolve(extensionRoot, '..', 'shared', 'dist');
const sharedPackageJsonPath = path.resolve(extensionRoot, '..', 'shared', 'package.json');

function copyDirectory(src, dest) {
  if (!fs.existsSync(src)) {
    throw new Error(`Source directory does not exist: ${src}`);
  }

  fs.mkdirSync(dest, { recursive: true });

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirectory(srcPath, destPath);
    } else if (entry.isSymbolicLink()) {
      const target = fs.readlinkSync(srcPath);
      fs.symlinkSync(target, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function createSharedPackage(dest) {
  const sharedPackage = JSON.parse(fs.readFileSync(sharedPackageJsonPath, 'utf8'));
  const minimalPackage = {
    name: sharedPackage.name,
    version: sharedPackage.version,
    main: './dist/index.js',
    types: './dist/index.d.ts'
  };

  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify(minimalPackage, null, 2));
}

function prepare() {
  if (!fs.existsSync(workerDist)) {
    throw new Error('Worker dist not found. Run the worker build before packaging.');
  }

  if (!fs.existsSync(sharedDist)) {
    throw new Error('Shared dist not found. Run the shared build before packaging.');
  }

  fs.rmSync(runtimeRoot, { recursive: true, force: true });

  // Copy worker runtime
  const runtimeWorker = path.join(runtimeRoot, 'worker');
  copyDirectory(workerDist, runtimeWorker);

  // Copy shared runtime under runtime/node_modules/@docpilot/shared
  const runtimeNodeModules = path.join(runtimeRoot, 'node_modules', '@docpilot', 'shared');
  copyDirectory(sharedDist, path.join(runtimeNodeModules, 'dist'));
  createSharedPackage(runtimeNodeModules);

  console.log('[docpilot] runtime assets prepared under extension/runtime');
}

prepare();

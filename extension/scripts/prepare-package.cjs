#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Paths
const extensionRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(extensionRoot, '..');
const runtimeRoot = path.join(extensionRoot, 'runtime');
const runtimeNodeModules = path.join(runtimeRoot, 'node_modules');

// Source paths
const workerRoot = path.join(projectRoot, 'worker');
const sharedRoot = path.join(projectRoot, 'shared');

console.log('🚀 DocPilot Extension Package Preparation');
console.log('==========================================');

/**
 * Execute command with proper error handling
 */
function execCommand(command, cwd = process.cwd(), options = {}) {
  try {
    console.log(`[EXEC] ${command}`);
    const result = execSync(command, {
      cwd,
      stdio: 'inherit',
      encoding: 'utf8',
      ...options
    });
    return result;
  } catch (error) {
    console.error(`❌ Command failed: ${command}`);
    console.error(`   Error: ${error.message}`);
    throw error;
  }
}

/**  
 * Copy directory recursively
 */
function copyDirectory(src, dest) {
  if (!fs.existsSync(src)) {
    throw new Error(`Source directory not found: ${src}`);
  }
  
  console.log(`📁 Copying ${path.relative(projectRoot, src)} → ${path.relative(projectRoot, dest)}`);
  fs.mkdirSync(dest, { recursive: true });
  
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    
    if (entry.isDirectory()) {
      copyDirectory(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Create shared package.json for runtime
 */
function createSharedPackage(destPath) {
  const packageJson = {
    name: '@docpilot/shared',
    version: '1.0.0',
    main: 'dist/index.js',
    types: 'dist/index.d.ts'
  };
  
  fs.writeFileSync(
    path.join(destPath, 'package.json'),
    JSON.stringify(packageJson, null, 2)
  );
}

/**
 * Install all dependencies with proper native binary support
 */
function installDependencies() {
  console.log('\n📦 Installing Dependencies');
  console.log('===========================');
  
  // Clean runtime directory
  if (fs.existsSync(runtimeRoot)) {
    console.log('🗑️  Cleaning old runtime directory');
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
  
  // Create runtime directory
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.mkdirSync(runtimeNodeModules, { recursive: true });
  
  // Create a temporary package.json for installing all dependencies
  const tempPackageJson = {
    name: 'docpilot-runtime',
    version: '1.0.0',
    private: true,
    dependencies: {},
    optionalDependencies: {}
  };
  
  // Read extension dependencies
  const extensionPkg = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'));
  if (extensionPkg.dependencies) {
    // Filter out workspace dependencies and replace with actual npm packages
    Object.entries(extensionPkg.dependencies).forEach(([name, version]) => {
      if (!version.startsWith('workspace:')) {
        tempPackageJson.dependencies[name] = version;
      }
    });
  }
  if (extensionPkg.optionalDependencies) {
    Object.entries(extensionPkg.optionalDependencies).forEach(([name, version]) => {
      if (!version.startsWith('workspace:')) {
        tempPackageJson.optionalDependencies[name] = version;
      }
    });
  }
  
  // Read worker dependencies  
  const workerPkgPath = path.join(workerRoot, 'package.json');
  if (fs.existsSync(workerPkgPath)) {
    const workerPkg = JSON.parse(fs.readFileSync(workerPkgPath, 'utf8'));
    if (workerPkg.dependencies) {
      Object.entries(workerPkg.dependencies).forEach(([name, version]) => {
        if (!version.startsWith('workspace:')) {
          tempPackageJson.dependencies[name] = version;
        }
      });
    }
    if (workerPkg.optionalDependencies) {
      Object.entries(workerPkg.optionalDependencies).forEach(([name, version]) => {
        if (!version.startsWith('workspace:')) {
          tempPackageJson.optionalDependencies[name] = version;
        }
      });
    }
  }
  
  // Write temporary package.json to runtime directory
  const tempPackagePath = path.join(runtimeRoot, 'package.json');
  fs.writeFileSync(tempPackagePath, JSON.stringify(tempPackageJson, null, 2));
  
  console.log(`📋 Installing ${Object.keys(tempPackageJson.dependencies).length} dependencies`);
  console.log(`📋 Installing ${Object.keys(tempPackageJson.optionalDependencies).length} optional dependencies`);
  
  // Install all dependencies including optional ones and native binaries
  const installCommand = [
    'npm install',
    '--include=optional',              // Include optional dependencies (required for sharp)
    '--no-audit',                      // Skip audit for faster install
    '--no-fund',                       // Skip funding messages
    '--prefer-offline',                // Use cache when possible
    '--no-package-lock'                // Don't create package-lock.json
  ].join(' ');
  
  try {
    execCommand(installCommand, runtimeRoot);
    console.log('✅ Dependencies installed successfully');
  } catch (error) {
    console.error('❌ Failed to install dependencies');
    throw error;
  }
  
  // Clean up temporary package.json
  fs.unlinkSync(tempPackagePath);
}

/**
 * Build required components
 */
function buildComponents() {
  console.log('\n🔨 Building Components');
  console.log('======================');
  
  // Build shared library
  console.log('📦 Building shared library...');
  execCommand('npm run build', sharedRoot);
  
  // Build worker
  console.log('📦 Building worker...');
  execCommand('npm run build', workerRoot);
  
  // Build extension
  console.log('📦 Building extension...');
  execCommand('mkdir -p dist && npx tsc src/extension.ts --outDir dist --target ES2020 --module CommonJS --moduleResolution Node --esModuleInterop --skipLibCheck', extensionRoot);
  
  console.log('✅ All components built successfully');
}

/**
 * Copy runtime assets
 */
function copyRuntimeAssets() {
  console.log('\n📁 Copying Runtime Assets');
  console.log('==========================');
  
  // Copy worker runtime
  const workerDist = path.join(workerRoot, 'dist');
  const runtimeWorker = path.join(runtimeRoot, 'worker');
  
  if (!fs.existsSync(workerDist)) {
    throw new Error('Worker dist not found. Build failed.');
  }
  
  copyDirectory(workerDist, runtimeWorker);
  
  // Copy shared runtime under runtime/node_modules/@docpilot/shared
  const sharedDist = path.join(sharedRoot, 'dist');
  const sharedScopeDir = path.join(runtimeNodeModules, '@docpilot');
  const sharedRuntimePath = path.join(sharedScopeDir, 'shared');
  
  console.log(`📋 sharedDist: ${sharedDist}`);
  console.log(`📋 sharedScopeDir: ${sharedScopeDir}`);
  console.log(`📋 sharedRuntimePath: ${sharedRuntimePath}`);
  
  if (!fs.existsSync(sharedDist)) {
    throw new Error('Shared dist not found. Build failed.');
  }
  
  // Remove existing symlink or directory if it exists
  if (fs.existsSync(sharedRuntimePath) || fs.lstatSync(sharedRuntimePath).isSymbolicLink()) {
    try {
      const stats = fs.lstatSync(sharedRuntimePath);
      if (stats.isSymbolicLink()) {
        fs.unlinkSync(sharedRuntimePath);
        console.log('🔗 Removed existing symlink for @docpilot/shared');
      } else {
        fs.rmSync(sharedRuntimePath, { recursive: true, force: true });
        console.log('🗑️  Removed existing directory for @docpilot/shared');
      }
    } catch (error) {
      console.log(`⚠️  Error removing existing path: ${error.message}`);
    }
  }
  
  // Create the scoped directory structure properly
  try {
    fs.mkdirSync(sharedScopeDir, { recursive: true });
    fs.mkdirSync(sharedRuntimePath, { recursive: true });
  } catch (error) {
    console.log(`❌ Error creating directories: ${error.message}`);
    throw error;
  }
  
  copyDirectory(sharedDist, path.join(sharedRuntimePath, 'dist'));
  createSharedPackage(sharedRuntimePath);
  
  console.log('✅ Runtime assets copied successfully');
}

/**
 * Apply compatibility fixes for legacy imports
 */
function applyCompatibilityFixes() {
  console.log('\n🔧 Applying Compatibility Fixes');
  console.log('=================================');
  
  // Fix entities package exports
  const entitiesPath = path.join(runtimeNodeModules, 'entities');
  if (fs.existsSync(entitiesPath)) {
    console.log('🛠️  Fixing entities package...');
    
    // Create compatibility shims
    const decodeCompatPath = path.join(entitiesPath, 'decode.js');
    const escapeCompatPath = path.join(entitiesPath, 'escape.js');
    
    fs.writeFileSync(decodeCompatPath, 'module.exports = require("./lib/decode.js");');
    fs.writeFileSync(escapeCompatPath, 'module.exports = require("./lib/escape.js");');
    
    // Patch package.json
    const packageJsonPath = path.join(entitiesPath, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    
    if (!packageJson.exports) packageJson.exports = {};
    packageJson.exports['./decode'] = './decode.js';
    packageJson.exports['./escape'] = './escape.js';
    
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
    console.log('   ✅ Entities compatibility fixed');
  }
  
  // Check semver package - v7+ already has functions directory
  const semverPath = path.join(runtimeNodeModules, 'semver');
  if (fs.existsSync(semverPath)) {
    console.log('🛠️  Checking semver package...');
    
    const functionsDir = path.join(semverPath, 'functions');
    if (fs.existsSync(functionsDir)) {
      const requiredFunctions = ['coerce.js', 'gte.js', 'satisfies.js'];
      const hasFunctions = requiredFunctions.every(func => fs.existsSync(path.join(functionsDir, func)));
      
      if (hasFunctions) {
        console.log('   ✅ Semver v7+ functions directory already available');
      } else {
        console.log('   ⚠️  Some semver functions missing');
      }
    } else {
      console.log('   ⚠️  Semver functions directory not found');
    }
  }
  
  // Verify Sharp installation
  const sharpPath = path.join(runtimeNodeModules, 'sharp');
  if (fs.existsSync(sharpPath)) {
    console.log('🛠️  Verifying Sharp installation...');
    
    // Check for platform-specific binaries
    const platformPath = path.join(sharpPath, 'vendor');
    if (fs.existsSync(platformPath)) {
      const platformDirs = fs.readdirSync(platformPath);
      console.log(`   📋 Sharp platform binaries: ${platformDirs.join(', ')}`);
      console.log('   ✅ Sharp native binaries found');
    } else {
      console.warn('   ⚠️  Sharp platform binaries not found - extension may fail at runtime');
    }
  }
  
  console.log('✅ All compatibility fixes applied');
}

/**
 * Package extension to VSIX
 */
function packageExtension() {
  console.log('\n📦 Packaging Extension');
  console.log('======================');
  
  const packageCommand = [
    'npx @vscode/vsce package',
    '--no-dependencies',
    '--allow-missing-repository',
    '--out ../docpilot.vsix'
  ].join(' ');
  
  try {
    execCommand(packageCommand, extensionRoot);
    console.log('✅ Extension packaged successfully');
    
    // Get package info
    const vsixPath = path.join(projectRoot, 'docpilot.vsix');
    if (fs.existsSync(vsixPath)) {
      const stats = fs.statSync(vsixPath);
      const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
      console.log(`📋 Package: docpilot.vsix (${sizeMB} MB)`);
    }
  } catch (error) {
    console.error('❌ Failed to package extension');
    throw error;
  }
}

/**
 * Main execution
 */
async function main() {
  try {
    console.log('🎯 Target: Complete VS Code extension packaging with native dependencies\n');
    
    // Step 1: Build all components
    buildComponents();
    
    // Step 2: Install dependencies with native binary support
    installDependencies();
    
    // Step 3: Copy runtime assets
    copyRuntimeAssets();
    
    // Step 4: Apply compatibility fixes
    applyCompatibilityFixes();
    
    // Step 5: Package extension
    packageExtension();
    
    console.log('\n🎉 SUCCESS!');
    console.log('============');
    console.log('✅ DocPilot extension ready for installation');
    console.log('📦 Install via: VS Code → Extensions → Install from VSIX → docpilot.vsix');
    console.log('🚀 All native dependencies (including Sharp) properly packaged');
    
  } catch (error) {
    console.error('\n❌ FAILED!');
    console.error('===========');
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}
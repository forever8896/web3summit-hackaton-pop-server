const express = require("express");
const { exec, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

// Job Queue System for Compilation
const jobs = new Map(); // In-memory job storage

// Simple ID generator (no external dependency)
function generateJobId() {
  return 'job_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// Job status constants
const JOB_STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running', 
  COMPLETED: 'completed',
  FAILED: 'failed'
};

// Job management functions
function createJob(contractName, code) {
  const jobId = generateJobId();
  const job = {
    id: jobId,
    contractName,
    code,
    status: JOB_STATUS.QUEUED,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    logs: [],
    stdout: '',
    stderr: '',
    result: null,
    error: null,
    exitCode: null
  };
  jobs.set(jobId, job);
  return job;
}

function getJob(jobId) {
  return jobs.get(jobId);
}

function updateJob(jobId, updates) {
  const job = jobs.get(jobId);
  if (job) {
    Object.assign(job, updates);
    jobs.set(jobId, job);
  }
  return job;
}

function addJobLog(jobId, type, message) {
  const job = jobs.get(jobId);
  if (job) {
    job.logs.push({
      timestamp: new Date().toISOString(),
      type,
      message
    });
    if (type === 'stdout') job.stdout += message;
    if (type === 'stderr') job.stderr += message;
  }
}

// Endpoint to create a new contract
app.post("/new-contract", async (req, res) => {
  const { contractName, contractType = "erc", template = "erc20" } = req.body;
  
  if (!contractName) {
    return res.status(400).json({ error: "Contract name is required" });
  }

  if (fs.existsSync(contractName)) {
    return res.status(400).json({ error: `Contract ${contractName} already exists` });
  }

  const command = `pop new contract ${contractName} --contract-type ${contractType} --template ${template}`;
  
  exec(command, (error, stdout, stderr) => {
    if (error) {
      return res.status(500).json({ 
        error: "Failed to create contract", 
        details: stderr || error.message 
      });
    }
    
    res.json({ 
      success: true, 
      message: `Contract ${contractName} created successfully`,
      contractName,
      logs: stdout 
    });
  });
});

// Endpoint to build a contract
app.post("/build", async (req, res) => {
  const { contractName } = req.body;
  
  if (!contractName) {
    return res.status(400).json({ error: "Contract name is required" });
  }

  if (!fs.existsSync(contractName)) {
    return res.status(404).json({ error: `Contract ${contractName} not found` });
  }

  const command = `cd ${contractName} && pop build`;
  
  exec(command, { timeout: 300000 }, (error, stdout, stderr) => { // 5 minute timeout
    if (error) {
      return res.status(500).json({ 
        error: "Failed to build contract", 
        details: stderr || error.message 
      });
    }
    
    res.json({ 
      success: true, 
      message: `Contract ${contractName} built successfully`,
      contractName,
      logs: stdout 
    });
  });
});

// Endpoint to deploy a contract
app.post("/deploy", async (req, res) => {
  const { contractName } = req.body;
  
  if (!contractName) {
    return res.status(400).json({ error: "Contract name is required" });
  }

  if (!fs.existsSync(contractName)) {
    return res.status(404).json({ error: `Contract ${contractName} not found` });
  }

  // Check if contract is built (target directory exists)
  const targetDir = path.join(contractName, "target");
  if (!fs.existsSync(targetDir)) {
    return res.status(400).json({ 
      error: `Contract ${contractName} must be built before deployment. Use /build endpoint first.` 
    });
  }

  const command = `cd ${contractName} && pop up`;
  
  exec(command, { timeout: 120000 }, (error, stdout, stderr) => { // 2 minute timeout
    if (error) {
      return res.status(500).json({ 
        error: "Failed to deploy contract", 
        details: stderr || error.message 
      });
    }

    const match = stdout.match(/Contract address: (0x[a-fA-F0-9]+)/);
    const address = match ? match[1] : "Not found";

    res.json({ 
      success: true, 
      message: `Contract ${contractName} deployed successfully`,
      contractName,
      address, 
      logs: stdout 
    });
  });
});

// Endpoint to compile Rust contract code
app.post("/compile", async (req, res) => {
  const { code, contractName = "temp_contract" } = req.body;
  
  if (!code) {
    return res.status(400).json({ error: "Rust contract code is required" });
  }

  // Use persistent directories for caching
  const baseDir = "/app/compile_cache";
  const cargoHome = path.join(baseDir, "cargo_home");
  const targetDir = path.join(baseDir, "target");
  const tempDir = path.join(baseDir, "temp", `${contractName}_${Date.now()}`);
  
  try {
    // Ensure cache directories exist
    fs.mkdirSync(baseDir, { recursive: true });
    fs.mkdirSync(cargoHome, { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });
    fs.mkdirSync(tempDir, { recursive: true });
    
    // Create optimized Cargo.toml for ink! contract with shared target
    const cargoToml = `[package]
name = "${contractName}"
version = "6.0.0-alpha"
authors = ["Use Ink <ink@use.ink>"]
edition = "2021"
publish = false

[dependencies]
ink = { version = "6.0.0-alpha", default-features = false, features = ["unstable-hostfn"] }

[dev-dependencies]
ink_e2e = { version = "6.0.0-alpha", default-features = false }

[lib]
path = "lib.rs"

[features]
default = ["std"]
std = [
    "ink/std",
]
ink-as-dependency = []
e2e-tests = []

[profile.dev]
incremental = true
codegen-units = 256

[profile.release]
incremental = true
codegen-units = 16
lto = "thin"
`;
    
    fs.writeFileSync(path.join(tempDir, "Cargo.toml"), cargoToml);
    
    // Write the provided Rust code to lib.rs (in root directory as per Cargo.toml)
    fs.writeFileSync(path.join(tempDir, "lib.rs"), code);
    
    // Run optimized compilation with shared cache and parallel builds
    const command = `cd ${tempDir} && pop build`;
    const env = {
      ...process.env,
      CARGO_HOME: cargoHome,
      CARGO_TARGET_DIR: targetDir,
      CARGO_INCREMENTAL: "1",
      RUSTC_WRAPPER: "", // Disable sccache if present to avoid conflicts
      CARGO_BUILD_JOBS: "4" // Use 4 parallel jobs
    };
    
    exec(command, { 
      timeout: 300000, 
      env: env,
      maxBuffer: 1024 * 1024 * 10 // 10MB buffer for large outputs
    }, (error, stdout, stderr) => {
      // Clean up temporary directory
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.warn("Failed to cleanup temp directory:", cleanupError.message);
      }
      
      if (error) {
        // Parse Rust compilation errors for better formatting
        const errorOutput = stderr || error.message;
        const rustErrors = parseRustErrors(errorOutput);
        
        return res.status(400).json({ 
          success: false,
          error: "Compilation failed", 
          details: errorOutput,
          rustErrors: rustErrors,
          logs: stdout || ""
        });
      }
      
      // Compilation successful
      res.json({ 
        success: true, 
        message: "Contract compiled successfully",
        contractName,
        logs: stdout,
        details: "Contract compiled without errors"
      });
    });
    
  } catch (setupError) {
    // Clean up on setup error
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch (cleanupError) {
      console.warn("Failed to cleanup temp directory:", cleanupError.message);
    }
    
    return res.status(500).json({ 
      error: "Failed to setup compilation environment", 
      details: setupError.message 
    });
  }
});

// Helper function to parse Rust compilation errors
function parseRustErrors(errorOutput) {
  const errors = [];
  const lines = errorOutput.split('\n');
  
  let currentError = null;
  
  for (const line of lines) {
    // Match error lines like "error[E0308]: mismatched types"
    const errorMatch = line.match(/^error\[([^\]]+)\]: (.+)$/);
    if (errorMatch) {
      if (currentError) {
        errors.push(currentError);
      }
      currentError = {
        code: errorMatch[1],
        message: errorMatch[2],
        details: []
      };
      continue;
    }
    
    // Match location lines like "  --> src/lib.rs:10:5"
    const locationMatch = line.match(/^\s*-->\s*(.+):(\d+):(\d+)$/);
    if (locationMatch && currentError) {
      currentError.location = {
        file: locationMatch[1],
        line: parseInt(locationMatch[2]),
        column: parseInt(locationMatch[3])
      };
      continue;
    }
    
    // Add other relevant lines to current error details
    if (currentError && line.trim() && !line.startsWith('Compiling') && !line.startsWith('Finished')) {
      currentError.details.push(line);
    }
  }
  
  // Add the last error if exists
  if (currentError) {
    errors.push(currentError);
  }
  
  return errors;
}

// ===== JOB QUEUE COMPILATION ENDPOINTS =====

// Submit compilation job - returns job_id immediately
app.post("/compile-job", async (req, res) => {
  const { code, contractName = "temp_contract" } = req.body;
  
  if (!code) {
    return res.status(400).json({ error: "Rust contract code is required" });
  }
  
  // Create job and return immediately
  const job = createJob(contractName, code);
  
  res.json({
    job_id: job.id,
    status: job.status,
    message: "Compilation job queued successfully",
    created_at: job.createdAt
  });
  
  // Start compilation asynchronously
  setImmediate(() => processCompilationJob(job.id));
});

// Get job status and results
app.get("/compile-job/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = getJob(jobId);
  
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }
  
  // Return job status and results
  const response = {
    job_id: job.id,
    status: job.status,
    contract_name: job.contractName,
    created_at: job.createdAt,
    started_at: job.startedAt,
    completed_at: job.completedAt,
    exit_code: job.exitCode
  };
  
  // Include results based on status
  if (job.status === JOB_STATUS.COMPLETED) {
    response.result = {
      message: "Contract compiled successfully",
      logs: job.stdout,
      details: "Compilation completed without errors"
    };
  } else if (job.status === JOB_STATUS.FAILED) {
    response.error = {
      message: job.error || "Compilation failed",
      details: job.stderr,
      logs: job.stdout,
      rust_errors: parseRustErrors(job.stderr)
    };
  }
  
  res.json(response);
});

// Get job logs (streaming or complete)
app.get("/compile-job/:jobId/logs", (req, res) => {
  const { jobId } = req.params;
  const { stream } = req.query;
  const job = getJob(jobId);
  
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }
  
  if (stream === 'true') {
    // Stream logs in real-time
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    
    // Send existing logs
    job.logs.forEach(log => {
      res.write(`event: ${log.type}\n`);
      res.write(`data: ${JSON.stringify({ ...log, job_id: jobId })}\n\n`);
    });
    
    // Keep connection alive for running jobs
    if (job.status === JOB_STATUS.RUNNING || job.status === JOB_STATUS.QUEUED) {
      const interval = setInterval(() => {
        const currentJob = getJob(jobId);
        if (!currentJob || currentJob.status === JOB_STATUS.COMPLETED || currentJob.status === JOB_STATUS.FAILED) {
          res.write(`event: complete\n`);
          res.write(`data: ${JSON.stringify({ job_id: jobId, status: currentJob?.status })}\n\n`);
          res.end();
          clearInterval(interval);
        }
      }, 1000);
      
      req.on('close', () => clearInterval(interval));
    } else {
      res.write(`event: complete\n`);
      res.write(`data: ${JSON.stringify({ job_id: jobId, status: job.status })}\n\n`);
      res.end();
    }
  } else {
    // Return complete logs as JSON
    res.json({
      job_id: jobId,
      status: job.status,
      logs: job.logs,
      stdout: job.stdout,
      stderr: job.stderr
    });
  }
});

// List all jobs
app.get("/compile-jobs", (req, res) => {
  const jobList = Array.from(jobs.values()).map(job => ({
    job_id: job.id,
    status: job.status,
    contract_name: job.contractName,
    created_at: job.createdAt,
    started_at: job.startedAt,
    completed_at: job.completedAt
  }));
  
  res.json({ jobs: jobList, total: jobList.length });
});

// Async compilation job processor
async function processCompilationJob(jobId) {
  const job = getJob(jobId);
  if (!job) return;
  
  try {
    // Update job status to running
    updateJob(jobId, { 
      status: JOB_STATUS.RUNNING, 
      startedAt: new Date().toISOString() 
    });
    
    addJobLog(jobId, 'info', 'Starting compilation...');
    
    // Setup compilation environment
    const baseDir = "/app/compile_cache";
    const cargoHome = path.join(baseDir, "cargo_home");
    const targetDir = path.join(baseDir, "target");
    const tempDir = path.join(baseDir, "temp", `${job.contractName}_${Date.now()}`);
    
    // Ensure directories exist
    fs.mkdirSync(baseDir, { recursive: true });
    fs.mkdirSync(cargoHome, { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });
    fs.mkdirSync(tempDir, { recursive: true });
    
    addJobLog(jobId, 'info', 'Created compilation environment');
    
    // Create Cargo.toml and lib.rs
    const cargoToml = `[package]
name = "${job.contractName}"
version = "6.0.0-alpha"
authors = ["Use Ink <ink@use.ink>"]
edition = "2021"
publish = false

[dependencies]
ink = { version = "6.0.0-alpha", default-features = false, features = ["unstable-hostfn"] }

[dev-dependencies]
ink_e2e = { version = "6.0.0-alpha", default-features = false }

[lib]
path = "lib.rs"

[features]
default = ["std"]
std = [
    "ink/std",
]
ink-as-dependency = []
e2e-tests = []

[profile.dev]
incremental = true
codegen-units = 256

[profile.release]
incremental = true
codegen-units = 16
lto = "thin"`;
    
    fs.writeFileSync(path.join(tempDir, "Cargo.toml"), cargoToml);
    fs.writeFileSync(path.join(tempDir, "lib.rs"), job.code);
    
    addJobLog(jobId, 'info', 'Created project files');
    
    // Run compilation
    const child = spawn('/root/.cargo/bin/pop', ['build'], {
      cwd: tempDir,
      env: {
        ...process.env,
        CARGO_HOME: cargoHome,
        CARGO_TARGET_DIR: targetDir,
        CARGO_INCREMENTAL: "1",
        CARGO_BUILD_JOBS: "4",
        PATH: '/root/.cargo/bin:' + process.env.PATH
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    let stdout = '';
    let stderr = '';
    
    child.stdout.on('data', (data) => {
      const output = data.toString();
      stdout += output;
      addJobLog(jobId, 'stdout', output);
    });
    
    child.stderr.on('data', (data) => {
      const output = data.toString();
      stderr += output;
      addJobLog(jobId, 'stderr', output);
    });
    
    child.on('close', (code) => {
      // Cleanup temp directory
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.warn("Failed to cleanup temp directory:", cleanupError.message);
      }
      
      if (code === 0) {
        updateJob(jobId, {
          status: JOB_STATUS.COMPLETED,
          completedAt: new Date().toISOString(),
          exitCode: code,
          result: "Compilation successful"
        });
        addJobLog(jobId, 'success', 'Compilation completed successfully');
      } else {
        updateJob(jobId, {
          status: JOB_STATUS.FAILED,
          completedAt: new Date().toISOString(),
          exitCode: code,
          error: "Compilation failed"
        });
        addJobLog(jobId, 'error', `Compilation failed with exit code ${code}`);
      }
    });
    
    child.on('error', (error) => {
      updateJob(jobId, {
        status: JOB_STATUS.FAILED,
        completedAt: new Date().toISOString(),
        error: error.message
      });
      addJobLog(jobId, 'error', `Process error: ${error.message}`);
    });
    
  } catch (error) {
    updateJob(jobId, {
      status: JOB_STATUS.FAILED,
      completedAt: new Date().toISOString(),
      error: error.message
    });
    addJobLog(jobId, 'error', `Setup error: ${error.message}`);
  }
}

// Streaming compile endpoint - real-time compilation output
app.post("/compile-stream", async (req, res) => {
  const { code, contractName = "temp_contract" } = req.body;
  
  if (!code) {
    return res.status(400).json({ error: "Rust contract code is required" });
  }

  // Set up Server-Sent Events
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });

  const sendEvent = (type, data) => {
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Use persistent directories for caching
  const baseDir = "/app/compile_cache";
  const cargoHome = path.join(baseDir, "cargo_home");
  const targetDir = path.join(baseDir, "target");
  const tempDir = path.join(baseDir, "temp", `${contractName}_${Date.now()}`);
  
  try {
    sendEvent('status', { message: 'Setting up compilation environment...', stage: 'setup' });
    
    // Ensure cache directories exist
    fs.mkdirSync(baseDir, { recursive: true });
    fs.mkdirSync(cargoHome, { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });
    fs.mkdirSync(tempDir, { recursive: true });
    
    sendEvent('status', { message: 'Creating project structure...', stage: 'project' });
    
    // Create optimized Cargo.toml for ink! contract with shared target
    const cargoToml = `[package]
name = "${contractName}"
version = "6.0.0-alpha"
authors = ["Use Ink <ink@use.ink>"]
edition = "2021"
publish = false

[dependencies]
ink = { version = "6.0.0-alpha", default-features = false, features = ["unstable-hostfn"] }

[dev-dependencies]
ink_e2e = { version = "6.0.0-alpha", default-features = false }

[lib]
path = "lib.rs"

[features]
default = ["std"]
std = [
    "ink/std",
]
ink-as-dependency = []
e2e-tests = []

[profile.dev]
incremental = true
codegen-units = 256

[profile.release]
incremental = true
codegen-units = 16
lto = "thin"
`;
    
    fs.writeFileSync(path.join(tempDir, "Cargo.toml"), cargoToml);
    fs.writeFileSync(path.join(tempDir, "lib.rs"), code);
    
    sendEvent('status', { message: 'Starting compilation...', stage: 'compile' });
    
    // Run optimized compilation with real-time streaming
    const child = spawn('/root/.cargo/bin/pop', ['build'], {
      cwd: tempDir,
      env: {
        ...process.env,
        CARGO_HOME: cargoHome,
        CARGO_TARGET_DIR: targetDir,
        CARGO_INCREMENTAL: "1",
        RUSTC_WRAPPER: "",
        CARGO_BUILD_JOBS: "4",
        PATH: '/root/.cargo/bin:' + process.env.PATH
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    let stdout = '';
    let stderr = '';
    
    child.stdout.on('data', (data) => {
      const output = data.toString();
      stdout += output;
      sendEvent('stdout', { data: output, timestamp: new Date().toISOString() });
    });
    
    child.stderr.on('data', (data) => {
      const output = data.toString();
      stderr += output;
      sendEvent('stderr', { data: output, timestamp: new Date().toISOString() });
    });
    
    child.on('error', (error) => {
      console.error('Process spawn error:', error);
      sendEvent('error', {
        message: 'Failed to start compilation process',
        details: error.message,
        rustErrors: [],
        logs: '',
        timestamp: new Date().toISOString()
      });
      sendEvent('complete', { finished: true, exitCode: null });
    });
    
    child.on('close', (code, signal) => {
      console.log(`Process closed with code: ${code}, signal: ${signal}`);
      console.log(`Stdout: ${stdout}`);
      console.log(`Stderr: ${stderr}`);
      
      // Clean up temporary directory
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.warn("Failed to cleanup temp directory:", cleanupError.message);
      }
      
      if (code === 0) {
        sendEvent('success', { 
          message: 'Contract compiled successfully',
          contractName,
          logs: stdout,
          timestamp: new Date().toISOString()
        });
      } else {
        const rustErrors = parseRustErrors(stderr);
        sendEvent('error', { 
          message: 'Compilation failed',
          details: stderr || 'No error details captured',
          rustErrors: rustErrors,
          logs: stdout || 'No output captured',
          exitCode: code,
          signal: signal,
          timestamp: new Date().toISOString()
        });
      }
      
      sendEvent('complete', { finished: true, exitCode: code });
      res.end();
    });
    
    child.on('error', (error) => {
      sendEvent('error', { 
        message: 'Process error',
        details: error.message,
        timestamp: new Date().toISOString()
      });
      res.end();
    });
    
    // Handle client disconnect
    req.on('close', () => {
      if (!child.killed) {
        child.kill();
      }
    });
    
  } catch (setupError) {
    sendEvent('error', { 
      message: 'Failed to setup compilation environment',
      details: setupError.message,
      timestamp: new Date().toISOString()
    });
    res.end();
  }
});

// Cache warming endpoint - pre-compile dependencies
app.post("/warm-cache", async (req, res) => {
  const baseDir = "/app/compile_cache";
  const cargoHome = path.join(baseDir, "cargo_home");
  const targetDir = path.join(baseDir, "target");
  const warmupDir = path.join(baseDir, "warmup");
  
  try {
    // Ensure cache directories exist
    fs.mkdirSync(baseDir, { recursive: true });
    fs.mkdirSync(cargoHome, { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });
    fs.mkdirSync(warmupDir, { recursive: true });
    
    // Create a minimal contract to warm up the cache
    const warmupCargoToml = `[package]
name = "warmup"
version = "6.0.0-alpha"
authors = ["Use Ink <ink@use.ink>"]
edition = "2021"
publish = false

[dependencies]
ink = { version = "6.0.0-alpha", default-features = false, features = ["unstable-hostfn"] }

[lib]
path = "lib.rs"

[features]
default = ["std"]
std = ["ink/std"]

[profile.dev]
incremental = true
codegen-units = 256
`;
    
    const warmupCode = `#![cfg_attr(not(feature = "std"), no_std, no_main)]

#[ink::contract]
mod warmup {
    #[ink(storage)]
    pub struct Warmup { value: u32 }
    
    impl Warmup {
        #[ink(constructor)]
        pub fn new() -> Self { Self { value: 0 } }
        
        #[ink(message)]
        pub fn get(&self) -> u32 { self.value }
    }
}`;
    
    fs.writeFileSync(path.join(warmupDir, "Cargo.toml"), warmupCargoToml);
    fs.writeFileSync(path.join(warmupDir, "lib.rs"), warmupCode);
    
    const command = `cd ${warmupDir} && pop build`;
    const env = {
      ...process.env,
      CARGO_HOME: cargoHome,
      CARGO_TARGET_DIR: targetDir,
      CARGO_INCREMENTAL: "1",
      CARGO_BUILD_JOBS: "4"
    };
    
    exec(command, { timeout: 600000, env: env }, (error, stdout, stderr) => {
      if (error) {
        return res.status(500).json({ 
          success: false,
          error: "Cache warming failed", 
          details: stderr || error.message 
        });
      }
      
      res.json({ 
        success: true, 
        message: "Cache warmed successfully - subsequent compilations will be faster",
        logs: stdout
      });
    });
    
  } catch (error) {
    res.status(500).json({ 
      error: "Failed to warm cache", 
      details: error.message 
    });
  }
});

// Streaming cache warming endpoint - real-time output
app.post("/warm-cache-stream", async (req, res) => {
  // Set up Server-Sent Events
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });

  const sendEvent = (type, data) => {
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const baseDir = "/app/compile_cache";
  const cargoHome = path.join(baseDir, "cargo_home");
  const targetDir = path.join(baseDir, "target");
  const warmupDir = path.join(baseDir, "warmup");
  
  try {
    sendEvent('status', { message: 'Setting up cache warming environment...', stage: 'setup' });
    
    // Ensure cache directories exist
    fs.mkdirSync(baseDir, { recursive: true });
    fs.mkdirSync(cargoHome, { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });
    fs.mkdirSync(warmupDir, { recursive: true });
    
    sendEvent('status', { message: 'Creating warmup project...', stage: 'project' });
    
    // Create a minimal contract to warm up the cache
    const warmupCargoToml = `[package]
name = "warmup"
version = "6.0.0-alpha"
authors = ["Use Ink <ink@use.ink>"]
edition = "2021"
publish = false

[dependencies]
ink = { version = "6.0.0-alpha", default-features = false, features = ["unstable-hostfn"] }

[lib]
path = "lib.rs"

[features]
default = ["std"]
std = ["ink/std"]

[profile.dev]
incremental = true
codegen-units = 256
`;
    
    const warmupCode = `#![cfg_attr(not(feature = "std"), no_std, no_main)]

#[ink::contract]
mod warmup {
    #[ink(storage)]
    pub struct Warmup { value: u32 }
    
    impl Warmup {
        #[ink(constructor)]
        pub fn new() -> Self { Self { value: 0 } }
        
        #[ink(message)]
        pub fn get(&self) -> u32 { self.value }
    }
}`;
    
    fs.writeFileSync(path.join(warmupDir, "Cargo.toml"), warmupCargoToml);
    fs.writeFileSync(path.join(warmupDir, "lib.rs"), warmupCode);
    
    sendEvent('status', { message: 'Starting cache warming compilation...', stage: 'compile' });
    
    const child = spawn('/root/.cargo/bin/pop', ['build'], {
      cwd: warmupDir,
      env: {
        ...process.env,
        CARGO_HOME: cargoHome,
        CARGO_TARGET_DIR: targetDir,
        CARGO_INCREMENTAL: "1",
        CARGO_BUILD_JOBS: "4",
        PATH: '/root/.cargo/bin:' + process.env.PATH
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    let stdout = '';
    let stderr = '';
    
    child.stdout.on('data', (data) => {
      const output = data.toString();
      stdout += output;
      sendEvent('stdout', { data: output, timestamp: new Date().toISOString() });
    });
    
    child.stderr.on('data', (data) => {
      const output = data.toString();
      stderr += output;
      sendEvent('stderr', { data: output, timestamp: new Date().toISOString() });
    });
    
    child.on('close', (code) => {
      if (code === 0) {
        sendEvent('success', { 
          message: 'Cache warmed successfully - subsequent compilations will be faster',
          logs: stdout,
          timestamp: new Date().toISOString()
        });
      } else {
        sendEvent('error', { 
          message: 'Cache warming failed',
          details: stderr,
          logs: stdout,
          timestamp: new Date().toISOString()
        });
      }
      
      sendEvent('complete', { finished: true, exitCode: code });
      res.end();
    });
    
    child.on('error', (error) => {
      sendEvent('error', { 
        message: 'Process error during cache warming',
        details: error.message,
        timestamp: new Date().toISOString()
      });
      res.end();
    });
    
    // Handle client disconnect
    req.on('close', () => {
      if (!child.killed) {
        child.kill();
      }
    });
    
  } catch (setupError) {
    sendEvent('error', { 
      message: 'Failed to setup cache warming environment',
      details: setupError.message,
      timestamp: new Date().toISOString()
    });
    res.end();
  }
});

// Cache status endpoint
app.get("/cache-status", (req, res) => {
  const baseDir = "/app/compile_cache";
  const cargoHome = path.join(baseDir, "cargo_home");
  const targetDir = path.join(baseDir, "target");
  
  try {
    const cacheExists = fs.existsSync(baseDir);
    const cargoHomeExists = fs.existsSync(cargoHome);
    const targetDirExists = fs.existsSync(targetDir);
    
    let cacheSize = 0;
    if (cacheExists) {
      try {
        const { execSync } = require('child_process');
        const sizeOutput = execSync(`du -sh ${baseDir}`, { encoding: 'utf8' });
        cacheSize = sizeOutput.split('\t')[0];
      } catch (e) {
        cacheSize = "unknown";
      }
    }
    
    res.json({
      cacheEnabled: true,
      cacheExists,
      cargoHomeExists,
      targetDirExists,
      cacheSize,
      cachePath: baseDir,
      status: cacheExists ? "ready" : "not-initialized"
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to check cache status" });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// List contracts endpoint
app.get("/contracts", (req, res) => {
  try {
    const contracts = fs.readdirSync(".")
      .filter(item => fs.statSync(item).isDirectory() && item !== "node_modules")
      .map(contractName => {
        const hasTarget = fs.existsSync(path.join(contractName, "target"));
        const hasCargoToml = fs.existsSync(path.join(contractName, "Cargo.toml"));
        
        return {
          name: contractName,
          isContract: hasCargoToml,
          isBuilt: hasTarget,
          status: hasTarget ? "built" : hasCargoToml ? "created" : "unknown"
        };
      })
      .filter(contract => contract.isContract);

    res.json({ contracts });
  } catch (error) {
    res.status(500).json({ error: "Failed to list contracts" });
  }
});

app.listen(3000, () => {
  console.log("Server running on port 3000");
  console.log("Available endpoints:");
  console.log("  POST /new-contract - Create a new contract");
  console.log("  POST /build - Build a contract");
  console.log("  POST /deploy - Deploy a built contract");
  console.log("  POST /compile - Compile Rust contract code (OPTIMIZED)");
  console.log("  POST /compile-stream - Compile with REAL-TIME streaming output");
  console.log("");
  console.log("  🆕 JOB QUEUE COMPILATION (RECOMMENDED):");
  console.log("  POST /compile-job - Submit compilation job (returns job_id)");
  console.log("  GET /compile-job/:jobId - Get job status and results");
  console.log("  GET /compile-job/:jobId/logs - Get job logs (add ?stream=true for real-time)");
  console.log("  GET /compile-jobs - List all compilation jobs");
  console.log("");
  console.log("  POST /warm-cache - Pre-compile dependencies for faster builds");
  console.log("  POST /warm-cache-stream - Warm cache with REAL-TIME streaming output");
  console.log("  GET /cache-status - Check compilation cache status");
  console.log("  GET /contracts - List all contracts");
  console.log("  GET /health - Health check");
  console.log("");
  console.log("💡 TIP: Use JOB QUEUE endpoints for reliable compilation!");
  console.log("🚀 TIP: Submit job with POST /compile-job, then poll GET /compile-job/:jobId");
  console.log("⚡ TIP: Run POST /warm-cache first to speed up compilations!");
});

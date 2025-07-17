const express = require("express");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

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
  console.log("  GET /contracts - List all contracts");
  console.log("  GET /health - Health check");
});

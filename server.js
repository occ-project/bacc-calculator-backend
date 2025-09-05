require('dotenv').config();
const mongoose = require('mongoose');

// Build MongoDB URI from environment variables with safe defaults
function constructMongoURI() {
  // Prefer a full URI if provided
  if (process.env.MONGODB_URI && process.env.MONGODB_URI.trim() !== '') {
    return process.env.MONGODB_URI;
  }

  const rawHost = process.env.MONGODB_HOST || 'localhost:27017';
  const dbName = process.env.MONGODB_DB || 'bacc-calculator';
  let host = rawHost;
  let protocol = '';

  if (host.startsWith('mongodb+srv://')) {
    protocol = 'mongodb+srv://';
    host = host.replace(/^mongodb\+srv:\/\//, '');
  } else if (host.startsWith('mongodb://')) {
    protocol = 'mongodb://';
    host = host.replace(/^mongodb:\/\//, '');
  } else {
    protocol = 'mongodb://';
  }

  if (process.env.MONGODB_USER && process.env.MONGODB_PASS) {
    const user = encodeURIComponent(process.env.MONGODB_USER);
    const pass = encodeURIComponent(process.env.MONGODB_PASS);
    // authSource=admin is common for Atlas; include retryWrites and w=majority
    return `${protocol}${user}:${pass}@${host}/${dbName}?authSource=admin&retryWrites=true&w=majority`;
  }

  return `${protocol}${host}/${dbName}`;
}

const MONGODB_URI = constructMongoURI();

// Do NOT log the full URI in production (it may contain credentials)
console.log('🔐 MongoDB connection method:', process.env.MONGODB_URI ? 'MONGODB_URI' : 'constructed from MONGODB_* env vars (credentials hidden)');

mongoose.connect(MONGODB_URI, {
  // Mongoose v6+ does not require these, but providing serverSelectionTimeoutMS helps fail fast on misconfiguration
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 10000
}).catch(err => {
  console.error('❌ MongoDB initial connect error:', err.message || err);
  if (err && err.message && err.message.toLowerCase().includes('authentication failed')) {
    console.error('🔎 Authentication failed: verify MONGODB_URI or MONGODB_USER/MONGODB_PASS and ensure special characters are URL-encoded.');
  }
  // Fail fast so the deploy surface indicates a problem with credentials/config
  process.exit(1);
});

mongoose.connection.on('connected', () => {
  console.log('✅ Connected to MongoDB');
});

mongoose.connection.on('error', (err) => {
  console.error('❌ MongoDB connection error:', err);
});

mongoose.connection.on('disconnected', () => {
  console.log('📴 MongoDB disconnected');
});

// server.js
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const researchRoutes = require('./routes/research');
const app = express();
const PORT = process.env.PORT || 5050;

// Middleware
app.use(cors());
app.use(helmet());
app.use(express.json());
app.use(rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 100 // limit each IP to 100 requests per windowMs
}));

app.use('/api', researchRoutes); //

 // Data file path
const DATA_FILE = path.join(__dirname, 'bacc_calculations.json');

// Function to save calculation data
function saveCalculationData(requestData, calculationResult) {
    const record = {
        timestamp: new Date().toISOString(),
        date: new Date().toLocaleDateString(),
        time: new Date().toLocaleTimeString(),
        rank: requestData.rank,
        location: requestData.location,
        costShare: requestData.costShare,
        numberOfChildren: requestData.children.length,
        children: requestData.children.map((child, i) => ({
            childNumber: i + 1,
            age: child.age
        })),
        totalMonthly: calculationResult.totalMonthly,
        totalAnnual: calculationResult.totalAnnual,
        perChildResults: calculationResult.perChild
    };

    // Read existing data
    let existingData = [];
    try {
        if (fs.existsSync(DATA_FILE)) {
            const fileContent = fs.readFileSync(DATA_FILE, 'utf8');
            existingData = JSON.parse(fileContent);
        }
    } catch (error) {
        console.log('Creating new data file...');
        existingData = [];
    }

    // Add new record
    existingData.push(record);

    // Save back to file
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(existingData, null, 2));
        console.log('💾 Data saved successfully');
    } catch (error) {
        console.error('❌ Error saving data:', error);
    }
}

// Simple route for testing
app.get('/', (req, res) => {
    res.json({ message: 'BACC Backend is running!' });
});

// BACC calculation endpoint with data saving
app.post('/api/calculate-bacc', (req, res) => {
    const { rank, location, costShare, children } = req.body;
    
    // Log user inputs
    console.log('\n=== NEW BACC CALCULATION REQUEST ===');
    console.log('Timestamp:', new Date().toLocaleString());
    console.log('Rank:', rank);
    console.log('Location:', location);
    console.log('Cost Share:', costShare + '%');
    console.log('Number of Children:', children ? children.length : 0);
    if (children && children.length > 0) {
        children.forEach((child, i) => {
            console.log(`  Child ${i + 1}: ${child.age || 'No age selected'}`);
        });
    }
    console.log('=====================================\n');
    
    // Validation
    if (!rank || !location || !children || !Array.isArray(children)) {
        console.log('❌ Request validation failed - missing required fields');
        return res.status(400).json({ error: 'Missing required fields.' });
    }
    
    // Data (should match what's in your frontend/app.js)
    const rankAllowances = {
        "E-1": 1200, "E-2": 1200, "E-3": 1150, "E-4": 1100, "E-5": 1000,
        "E-6": 950, "E-7": 900, "E-8": 800, "E-9": 700, "W-1": 950, "W-2": 900,
        "W-3": 850, "W-4": 800, "W-5": 650, "O-1": 900, "O-2": 850, "O-3": 800,
        "O-4": 700, "O-5": 650, "O-6": 550, "O-7": 450, "O-8": 400, "O-9": 350, "O-10": 300
    };
    const geographicMultipliers = {
        "Low Cost": 0.8, "Standard Cost": 1.0, "High Cost": 1.5
    };
    const ageMultipliers = {
        "Infant (0-12 months)": 1.4,
        "Toddler (13-24 months)": 1.3,
        "Preschool (25-60 months)": 1.0,
        "School-age (6-13 years)": 0.4
    };
    
    // Calculation
    const baseAllowance = rankAllowances[rank];
    const geoMultiplier = geographicMultipliers[location];
    const costShareDecimal = (typeof costShare === "number" ? costShare : parseFloat(costShare)) / 100;
    let results = [];
    let totalMonthly = 0;
    
    for (const child of children) {
        const ageMultiplier = ageMultipliers[child.age];
        if (!ageMultiplier) continue;
        const beforeCostShare = baseAllowance * geoMultiplier * ageMultiplier;
        const finalAmount = beforeCostShare * (1 - costShareDecimal);
        const amountRounded = Math.round(finalAmount * 100) / 100;
        results.push({
            age: child.age,
            amount: amountRounded,
            breakdown: {
                baseAllowance,
                geoMultiplier,
                ageMultiplier,
                costShareDecimal,
                beforeCostShare: Math.round(beforeCostShare * 100) / 100
            }
        });
        totalMonthly += amountRounded;
    }
    
    const calculationResult = {
        perChild: results,
        totalMonthly: Math.round(totalMonthly * 100) / 100,
        totalAnnual: Math.round(totalMonthly * 12 * 100) / 100
    };
    
    // 🟦 SAVE DATA TO FILE
    saveCalculationData(req.body, calculationResult);
    
    console.log('✅ Calculation completed successfully');
    console.log('Total Monthly:', calculationResult.totalMonthly);
    console.log('Total Annual:', calculationResult.totalAnnual);
    
    res.json(calculationResult);
});

// 🟦 NEW ENDPOINT: Download data as CSV
app.get('/api/export-csv', (req, res) => {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            return res.status(404).json({ error: 'No data available' });
        }

        const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        
        // Create CSV headers
        let csv = 'Date,Time,Rank,Location,Cost Share %,Number of Children,Total Monthly,Total Annual,Child Details\n';
        
        // Add data rows
        data.forEach(record => {
            const childDetails = record.children.map(child => `${child.childNumber}:${child.age}`).join('; ');
            csv += `"${record.date}","${record.time}","${record.rank}","${record.location}",${record.costShare},${record.numberOfChildren},$${record.totalMonthly},$${record.totalAnnual},"${childDetails}"\n`;
        });

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=bacc_calculations.csv');
        res.send(csv);
        
        console.log('📊 CSV export downloaded');
    } catch (error) {
        console.error('❌ Error exporting CSV:', error);
        res.status(500).json({ error: 'Error exporting data' });
    }
});

// 🟦 NEW ENDPOINT: View saved data
app.get('/api/data', (req, res) => {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            return res.json({ message: 'No data available', count: 0, data: [] });
        }

        const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        res.json({ 
            message: 'Data retrieved successfully', 
            count: data.length, 
            data: data 
        });
    } catch (error) {
        console.error('❌ Error reading data:', error);
        res.status(500).json({ error: 'Error reading data' });
    }
});

// Survey submission endpoint
app.post('/api/submit-survey', (req, res) => {
  try {
    const { timestamp, responses } = req.body;
    
    // Log survey submission
    console.log('\n=== NEW SURVEY SUBMISSION ===');
    console.log('Timestamp:', new Date(timestamp).toLocaleString());
    console.log('Responses:', Object.keys(responses).length, 'questions answered');
    console.log('=====================================\n');
    
    // Save survey data
    saveSurveyData({ timestamp, responses });
    
    res.json({ success: true, message: 'Survey submitted successfully' });
  } catch (error) {
    console.error('Error saving survey:', error);
    res.status(500).json({ error: 'Error saving survey data' });
  }
});

// Function to save survey data
function saveSurveyData(surveyData) {
  const SURVEY_FILE = path.join(__dirname, 'bacc_survey_responses.json');
  
  const record = {
    id: generateSurveyId(),
    submittedAt: new Date(surveyData.timestamp).toISOString(),
    date: new Date(surveyData.timestamp).toLocaleDateString(),
    time: new Date(surveyData.timestamp).toLocaleTimeString(),
    responses: surveyData.responses
  };

  // Read existing data
  let existingData = [];
  try {
    if (fs.existsSync(SURVEY_FILE)) {
      const fileContent = fs.readFileSync(SURVEY_FILE, 'utf8');
      existingData = JSON.parse(fileContent);
    }
  } catch (error) {
    console.log('Creating new survey data file...');
    existingData = [];
  }

  // Add new record
  existingData.push(record);

  // Save back to file
  try {
    fs.writeFileSync(SURVEY_FILE, JSON.stringify(existingData, null, 2));
    console.log('📋 Survey data saved successfully');
  } catch (error) {
    console.error('❌ Error saving survey data:', error);
  }
}

// Generate unique survey ID
function generateSurveyId() {
  return 'survey_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// Export survey data as CSV
app.get('/api/export-survey-csv', (req, res) => {
  try {
    const SURVEY_FILE = path.join(__dirname, 'bacc_survey_responses.json');
    
    if (!fs.existsSync(SURVEY_FILE)) {
      return res.status(404).json({ error: 'No survey data available' });
    }

    const data = JSON.parse(fs.readFileSync(SURVEY_FILE, 'utf8'));
    
    let csv = 'ID,Date,Time,Current Programs,Program Preference,Quality Care Impact,Mission Readiness Impact,Marital Status,Spouse Impact,Career Impact,Current Hurdles,Follow-up Comments\n';
    

    // Add data rows
    data.forEach(record => {
      const r = record.responses;
      const hurdles = Array.isArray(r.currentHurdles) ? r.currentHurdles.join('; ') : (r.currentHurdles || '');
      const followUps = Object.keys(r).filter(key => key.includes('_followup')).map(key => `${key}: ${r[key]}`).join(' | ');
      
     csv += `"${record.id}","${record.date}","${record.time}","${r.currentPrograms || ''}","${r.programPreference || ''}","${r.qualityCare || ''}","${r.missionReadiness || ''}","${r.maritalStatus || ''}","${r.spouseImpact || ''}","${r.careerDecision || ''}","${hurdles}","${followUps}"\n`;

});
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=bacc_survey_responses.csv');
    res.send(csv);
    
    console.log('📊 Survey CSV export downloaded');
  } catch (error) {
    console.error('❌ Error exporting survey CSV:', error);
    res.status(500).json({ error: 'Error exporting survey data' });
  }
});

// View survey data
app.get('/api/survey-data', (req, res) => {
  try {
    const SURVEY_FILE = path.join(__dirname, 'bacc_survey_responses.json');
    
    if (!fs.existsSync(SURVEY_FILE)) {
      return res.json({ message: 'No survey data available', count: 0, data: [] });
    }

    const data = JSON.parse(fs.readFileSync(SURVEY_FILE, 'utf8'));
    res.json({ 
      message: 'Survey data retrieved successfully', 
      count: data.length, 
      data: data 
    });
  } catch (error) {
    console.error('❌ Error reading survey data:', error);
    res.status(500).json({ error: 'Error reading survey data' });
  }
});

// Start the server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server is running at http://0.0.0.0:${PORT}`);
});

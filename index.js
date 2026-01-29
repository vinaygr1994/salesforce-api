/************************************
 * Load Environment Variables
 ************************************/
require('dotenv').config();
const express = require('express');
const jsforce = require('jsforce');

const app = express();
app.use(express.json());

/************************************
 * Salesforce OAuth Setup
 ************************************/
const oauth2 = new jsforce.OAuth2({
  loginUrl: process.env.SF_LOGIN_URL,
  clientId: process.env.SF_CLIENT_ID,
  clientSecret: process.env.SF_CLIENT_SECRET
});

const conn = new jsforce.Connection({ oauth2 });

async function connectSalesforce() {
  try {
    const response = await fetch(
      `${process.env.SF_LOGIN_URL}/services/oauth2/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: process.env.SF_CLIENT_ID,
          client_secret: process.env.SF_CLIENT_SECRET,
          refresh_token: process.env.SF_REFRESH_TOKEN
        })
      }
    );

    const token = await response.json();
    if (!token.access_token) throw new Error('Salesforce auth failed');

    conn.accessToken = token.access_token;
    conn.instanceUrl = token.instance_url;
    conn.refreshToken = process.env.SF_REFRESH_TOKEN;
    console.log('✅ Salesforce connected');
  } catch (err) {
    console.error('❌ Salesforce Connection Error:', err.message);
  }
}
connectSalesforce();

/************************************
 * Middleware: API Key Protection
 ************************************/
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== process.env.X_API_KEY) {
    return res.status(403).json({ error: 'Forbidden – Invalid API Key' });
  }
  next();
});

/************************************
 * HELPER: Split Name
 ************************************/
function splitName(fullName = '') {
  const parts = fullName.trim().split(' ');
  return {
    firstName: parts[0] || 'Unknown',
    lastName: parts.slice(1).join(' ') || 'Lead'
  };
}

/************************************
 * HELPER: Smart Project Detection
 * Scans BOTH Project Type and Scope for keywords
 ************************************/
function detectProjectType(projectInput, scopeInput) {
  // Combine both inputs into one long string to search
  const textToScan = (projectInput + ' ' + scopeInput).toLowerCase();

  // --- PRIORITY 1: Specific Phrases (Longer matches first) ---
  if (textToScan.includes('kitchen remodeling')) return 'Kitchen remodeling';
  if (textToScan.includes('bathroom remodeling')) return 'Bathroom remodeling';
  if (textToScan.includes('full home')) return 'Full Home Remodel';
  if (textToScan.includes('whole house')) return 'Full Home Remodel';
  if (textToScan.includes('new room')) return 'New room addition';
  if (textToScan.includes('home interior')) return 'Home interior design';
  if (textToScan.includes('interior design')) return 'Home interior design';

  // --- PRIORITY 2: Single Words ---
  if (textToScan.includes('kitchen')) return 'Kitchen';
  if (textToScan.includes('bath')) return 'Bathroom';
  if (textToScan.includes('basement')) return 'Basement';
  if (textToScan.includes('exterior')) return 'Exterior';
  if (textToScan.includes('deck')) return 'Exterior';
  if (textToScan.includes('roof')) return 'Exterior';
  if (textToScan.includes('adu')) return 'ADU';
  if (textToScan.includes('addition')) return 'Addition';

  // --- PRIORITY 3: General Fallback ---
  if (textToScan.includes('remodel')) return 'Remodeling';

  // Return undefined so Salesforce can leave it blank or handle it manually
  return undefined; 
}

function mapLeadSource(source) {
  if (!source) return 'Referral';
  const map = {
    'google lsa': 'Google LSA',
    'google calls': 'Google Calls',
    'google form': 'Google Form',
    'yelp': 'Yelp',
    'houzz': 'Houzz',
    'angi': 'Angi',
    'porch': 'Porch',
    'thumbtack': 'Thumbtack',
    'meta': 'Meta'
  };
  return map[source.toString().toLowerCase().trim()] || 'Referral';
}

/************************************
 * CREATE LEAD API
 ************************************/
app.post('/lead', async (req, res) => {
  try {
    if (!conn.accessToken) await connectSalesforce();

    // 1. Get Raw Data
    const fullName = req.body.full_name || req.body.Name || 'Unknown Lead';
    const rawSource = req.body.source || req.body.Source;
    const rawProject = req.body.project_type || req.body['Project Type'] || '';
    const rawScope = req.body.scope || req.body.description || req.body['Scope of Work'] || '';

    // 2. Process Data
    const { firstName, lastName } = splitName(fullName);
    const leadSource = mapLeadSource(rawSource);
    
    // 3. Detect Project Type using BOTH fields
    const finalProjectType = detectProjectType(rawProject, rawScope);

    // 4. Prepare Salesforce Payload
    const leadPayload = {
      FirstName: firstName,
      LastName: lastName,
      Company: req.body.company || req.body.Company || 'Unknown',
      Email: req.body.email || req.body.Email || undefined,
      Phone: req.body.phone || req.body.Phone || undefined,
      Lead_Source__c: leadSource,
      Project_Type__c: finalProjectType, // Now auto-detected from Scope too
      Scope_of_Work__c: rawScope
    };

    console.log('📤 Sending Payload:', leadPayload);

    const result = await conn.sobject('Lead').create(leadPayload, {
      headers: { 'Sforce-Auto-Assign': 'true' }
    });

    console.log(`✅ Success: Lead ${result.id} Created`);

    res.status(201).json({
      success: true,
      leadId: result.id,
      detectedProject: finalProjectType
    });

  } catch (err) {
    console.error('❌ ERROR:', err.message);
    // Respond with 500 but include the error message
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', salesforceConnected: !!conn.accessToken });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

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

/************************************
 * Salesforce OAuth Refresh Logic
 ************************************/
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

    console.log('✅ Salesforce connected');
  } catch (err) {
    console.error('❌ Salesforce Connection Error:', err.message);
  }
}

// Initial connection on startup
connectSalesforce();

/************************************
 * Middleware: API Key Protection
 ************************************/
app.use((req, res, next) => {
  if (req.path === '/health') return next();

  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(403).json({ error: 'Forbidden – Invalid API Key' });
  }
  next();
});

/************************************
 * Helper Functions
 ************************************/
function splitName(fullName = '') {
  const parts = fullName.trim().split(' ');
  return {
    firstName: parts[0] || 'Unknown',
    lastName: parts.slice(1).join(' ') || 'Lead'
  };
}

function normalizeProjectType(value) {
  if (!value) return null;
  const map = {
    kitchen: 'Kitchen',
    bathroom: 'Bathroom',
    'full home': 'Full Home',
    basement: 'Basement',
    addition: 'Addition',
    exterior: 'Exterior'
  };
  return map[value.toLowerCase()] || 'Other';
}

function mapLeadSource(source) {
  const map = {
    'google lsa': 'Google LSA',
    'google calls': 'Google Calls',
    'google form': 'Google Form',
    yelp: 'Yelp',
    houzz: 'Houzz',
    angi: 'Angi',
    porch: 'Porch',
    thumbtack: 'Thumbtack',
    meta: 'Meta'
  };
  return map[source?.toLowerCase()] || 'Referral';
}

/************************************
 * CREATE LEAD API (The Core Logic)
 ************************************/
app.post('/lead', async (req, res) => {
  try {
    // Check if token is expired/missing
    if (!conn.accessToken) await connectSalesforce();

    const { firstName, lastName } = splitName(req.body.full_name);
    const rawSource = req.body.source;
    const leadSource = mapLeadSource(rawSource);
    
    // ALERT: Unknown source check
    if (leadSource === 'Referral') {
      console.warn(`🚨 ALERT: Unrecognized source: "${rawSource}". Lead may not trigger Round-Robin.`);
    }

    const leadPayload = {
      FirstName: firstName,
      LastName: lastName,
      Company: req.body.company || 'Unknown',
      Email: req.body.email || undefined,
      Phone: req.body.phone || undefined,
      
      // CRITICAL: Mapping to your Custom Field for Day 9 Flow
      Lead_Source__c: leadSource, 
      
      Project_Type__c: normalizeProjectType(req.body.project_type) || undefined,
      Scope_of_Work__c: req.body.scope || undefined
    };

    console.log('📤 Payload:', leadPayload);

    /* CRITICAL: The Sforce-Auto-Assign header triggers Assignment Rules, 
      which then triggers your Round-Robin Flow
    */
    const result = await conn.sobject('Lead').create(leadPayload, {
      headers: {
        'Sforce-Auto-Assign': 'true'
      }
    });

    console.log(`✅ Success: Lead ${result.id} created via ${leadSource}`);

    res.status(201).json({
      success: true,
      leadId: result.id,
      assignedSource: leadSource
    });

  } catch (err) {
    console.error('❌ CRITICAL ERROR:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/************************************
 * Health Check & Status
 ************************************/
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    salesforceConnected: !!conn.accessToken,
    timestamp: new Date().toISOString()
  });
});

/************************************
 * Start Server
 ************************************/
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 API Server running on port ${PORT}`)
);

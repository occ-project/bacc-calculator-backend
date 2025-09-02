const express = require('express');
const router = express.Router();
const ResearchData = require('../models/ResearchData');

// POST /api/research-data - Save unified calculator + survey data
router.post('/research-data', async (req, res) => {
  try {
    const { sessionId, calculatorData, surveyData, metadata, completionStatus } = req.body;

    if (!sessionId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Session ID is required' 
      });
    }

    console.log(`Saving research data for session: ${sessionId}`);

    let researchRecord = await ResearchData.findOne({ sessionId });

    if (researchRecord) {
      // Update existing record
      researchRecord.calculatorData = new Map(Object.entries(calculatorData || {}));
      researchRecord.surveyData = new Map(Object.entries(surveyData || {}));
      researchRecord.metadata = { ...researchRecord.metadata, ...metadata };
      researchRecord.completionStatus = { ...researchRecord.completionStatus, ...completionStatus };
      researchRecord.updatedAt = new Date();
      
      await researchRecord.save();

      res.json({
        success: true,
        message: 'Research data updated successfully',
        sessionId: sessionId
      });
    } else {
      // Create new record
      researchRecord = new ResearchData({
        sessionId,
        calculatorData: new Map(Object.entries(calculatorData || {})),
        surveyData: new Map(Object.entries(surveyData || {})),
        metadata: metadata || {},
        completionStatus: completionStatus || {}
      });

      await researchRecord.save();

      res.json({
        success: true,
        message: 'Research data saved successfully',
        sessionId: sessionId
      });
    }

  } catch (error) {
    console.error('Error saving research data:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// GET /api/research-data/export/csv - Export all research data as CSV
router.get('/research-data/export/csv', async (req, res) => {
  try {
    const allRecords = await ResearchData.find({}).sort({ createdAt: -1 });

    if (allRecords.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No research data found for export'
      });
    }

    const csvContent = generateUnifiedCSV(allRecords);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="bacc-research-data-export.csv"');
    res.send(csvContent);

  } catch (error) {
    console.error('Error exporting research data:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to export research data'
    });
  }
});

function generateUnifiedCSV(records) {
  const headers = ['SessionID', 'RecordCreated', 'DataType', 'Field', 'Value', 'QuestionText', 'Result', 'Timestamp'];
  const rows = [headers.join(',')];

  records.forEach(record => {
    // Add calculator data rows
    if (record.calculatorData && record.calculatorData.size > 0) {
      record.calculatorData.forEach((info, field) => {
        rows.push([
          record.sessionId,
          record.createdAt?.toISOString() || '',
          'Calculator',
          field,
          `"${JSON.stringify(info.input).replace(/"/g, '""')}"`,
          '""',
          `"${JSON.stringify(info.result || '').replace(/"/g, '""')}"`,
          info.timestamp?.toISOString() || ''
        ].join(','));
      });
    }

    // Add survey data rows
    if (record.surveyData && record.surveyData.size > 0) {
      record.surveyData.forEach((info, questionId) => {
        rows.push([
          record.sessionId,
          record.createdAt?.toISOString() || '',
          'Survey',
          questionId,
          `"${JSON.stringify(info.response).replace(/"/g, '""')}"`,
          `"${(info.questionText || '').replace(/"/g, '""')}"`,
          '""',
          info.timestamp?.toISOString() || ''
        ].join(','));
      });
    }
  });

  return rows.join('\n');
}

module.exports = router;

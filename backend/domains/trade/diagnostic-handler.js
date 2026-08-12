function createDiagnosticHandler({ readinessService, sendError }) {
  return async function diagnosticHandler(req, res) {
    try {
      if (await readinessService.persistedEngineDesiredRunning()) {
        const error = new Error('GMGN diagnostics are disabled while live execution is desired or active');
        error.code = 'GMGN_DIAGNOSTIC_BLOCKED_WHILE_LIVE';
        throw error;
      }
      const preview = readinessService.diagnosticPreview({
        chain: req.params.chain,
        whitelistIds: req.body?.whitelist_ids
      });
      if (req.body?.confirmation !== 'RUN READ ONLY DIAGNOSTIC') {
        return res.json({ ok: true, data: { requires_confirmation: true, preview } });
      }
      if (req.body?.preview_hash !== preview.preview_hash) {
        return res.status(409).json({
          ok: false,
          error: 'Diagnostic preview changed; request a fresh preview before confirmation',
          code: 'DIAGNOSTIC_PREVIEW_CHANGED'
        });
      }
      const data = await readinessService.runDiagnostic({
        chain: req.params.chain,
        whitelistIds: req.body?.whitelist_ids
      });
      return res.json({ ok: true, data: { preview, result: data } });
    } catch (error) {
      return sendError(res, error);
    }
  };
}

module.exports = { createDiagnosticHandler };

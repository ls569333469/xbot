const db = require('../../lib/db');

function dbStatus(result) {
  return ['resolved', 'rejected', 'ambiguous', 'not_found', 'provider_failed'].includes(result.status)
    ? result.status : 'provider_failed';
}

async function persist(job, result, executor = db) {
  const selected = result.selectedCandidate || null;
  const attemptResult = await executor.query(
    `INSERT INTO dynamic_ca_resolution_attempts
      (x_provider_event_id, x_activity_id, kol_id, actor_handle, source_provider,
       source_event_id, event_type, resolver_revision, intent_rule_revision,
       intent_class, intent_reason_codes, observed_terms, author_owned_terms, quoted_terms,
       allowed_chain_ids, status, selected_family_id, selected_variant_id,
       resolution_confidence, resolution_reason_codes, failure_code, candidate_coverage,
       provider_snapshot, timing_json, started_at, completed_at, dynamic_job_id,
       actor_policy_id, actor_policy_revision, processing_mode, policy_context_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
       $21,$22,$23,$24,$25,NOW(),$26,$27,$28,$29,$30)
     ON CONFLICT (dynamic_job_id) WHERE dynamic_job_id IS NOT NULL DO UPDATE SET
       status = EXCLUDED.status, selected_family_id = EXCLUDED.selected_family_id,
       selected_variant_id = EXCLUDED.selected_variant_id,
       resolution_confidence = EXCLUDED.resolution_confidence,
       resolution_reason_codes = EXCLUDED.resolution_reason_codes,
       failure_code = EXCLUDED.failure_code,
       candidate_coverage = EXCLUDED.candidate_coverage,
       provider_snapshot = EXCLUDED.provider_snapshot,
       timing_json = EXCLUDED.timing_json, completed_at = NOW(), updated_at = NOW()
     RETURNING *`,
    [job.x_provider_event_id, job.x_activity_id, job.kol_id, job.kol_handle, '6551',
      `${job.provider_event_id || job.x_activity_id}:policy:${job.actor_policy_id}:rev:${job.policy_revision}`, job.activity_type,
      result.resolverRevision, result.intent?.ruleRevision || 'unknown',
      result.intent?.intentClass || 'unknown', result.intent?.reasonCodes || [],
      JSON.stringify(result.extraction?.observedTerms || []),
      JSON.stringify(result.extraction?.authorOwnedTerms || []),
      JSON.stringify(result.extraction?.quotedTerms || []), job.allowed_chain_ids || [], dbStatus(result),
      selected?.assetFamilyId || null, selected?.variantId || selected?.id || null,
      result.confidence || 'unknown', result.reasonCodes || [], result.failureCode || null,
      JSON.stringify(result.candidateCoverage || {}),
      JSON.stringify({ candidates: (result.candidates || []).length }),
      JSON.stringify(result.timing || {}), job.started_at || new Date(), job.id, job.actor_policy_id,
      job.policy_revision, job.mode, job.context_hash]
  );
  const attempt = attemptResult.rows[0];
  await executor.query(
    'DELETE FROM dynamic_ca_resolution_candidates WHERE resolution_attempt_id = $1', [attempt.id]
  );
  for (const candidate of result.candidates || []) {
    await executor.query(
      `INSERT INTO dynamic_ca_resolution_candidates
        (resolution_attempt_id, variant_id, chain_id, contract_address, score,
         strong_anchor_codes, support_reason_codes, rejection_reason_codes,
         provider_status, tradable_status, field_availability, provider_snapshot, selected)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [attempt.id, candidate.variantId || candidate.id || null, candidate.chainId,
        candidate.contractAddress, candidate.score ?? null, candidate.strongAnchorCodes || [],
        candidate.supportReasonCodes || [], candidate.rejectionReasonCodes || [],
        candidate.providerStatus || 'unknown', candidate.tradableStatus || 'unknown',
        JSON.stringify(candidate.fieldAvailability || {}),
        JSON.stringify(candidate.providerSnapshot || {}),
        Boolean(selected && candidate.chainId === selected.chainId
          && candidate.contractAddress === selected.contractAddress)]
    );
  }
  const jobResult = await executor.query(
      `UPDATE dynamic_signal_jobs SET resolution_attempt_id = $2,
        status = $3, failure_code = $4, last_error = NULL,
        completed_at = NOW(), lease_expires_at = NULL, locked_at = NULL, updated_at = NOW()
      WHERE id = $1 AND status = 'processing' AND worker_id = $5
        AND lease_expires_at > NOW()`,
     [job.id, attempt.id, result.status === 'resolved' ? 'resolved' : 'rejected',
       result.failureCode || null, job.worker_id]
  );
  if (jobResult.rowCount !== 1) {
    const error = new Error('Dynamic job lease was lost before resolution commit');
    error.code = 'DYNAMIC_JOB_LEASE_LOST';
    throw error;
  }
  return attempt;
}

async function list(filters = {}, executor = db) {
  const limit = Math.min(200, Math.max(1, Number(filters.limit || 50)));
  const params = [limit];
  let where = '';
  if (filters.actor_policy_id) {
    params.push(Number(filters.actor_policy_id));
    where += ` AND attempt.actor_policy_id = $${params.length}`;
  }
  if (filters.status) {
    params.push(String(filters.status));
    where += ` AND attempt.status = $${params.length}`;
  }
  const result = await executor.query(
    `SELECT attempt.*, variant.chain_id, variant.contract_address, variant.name, variant.symbol,
            policy.mode AS policy_mode, kol.x_handle,
            COALESCE((SELECT json_agg(candidate ORDER BY candidate.score DESC NULLS LAST)
              FROM dynamic_ca_resolution_candidates candidate
              WHERE candidate.resolution_attempt_id = attempt.id), '[]') AS candidates
     FROM dynamic_ca_resolution_attempts attempt
     LEFT JOIN dynamic_asset_variants variant ON variant.id = attempt.selected_variant_id
     LEFT JOIN x_actor_dynamic_policies policy ON policy.id = attempt.actor_policy_id
     LEFT JOIN x_kol_accounts kol ON kol.id = policy.kol_id
     WHERE 1=1 ${where}
     ORDER BY attempt.created_at DESC LIMIT $1`, params
  );
  return result.rows;
}

async function getById(id, executor = db) {
  const result = await executor.query(
    `SELECT attempt.*, variant.chain_id, variant.contract_address, variant.name, variant.symbol,
            variant.launchpad, variant.exchange, variant.official_x_handles,
            policy.mode AS policy_mode, kol.x_handle,
            COALESCE((SELECT json_agg(candidate ORDER BY candidate.selected DESC,
              candidate.score DESC NULLS LAST)
              FROM dynamic_ca_resolution_candidates candidate
              WHERE candidate.resolution_attempt_id = attempt.id), '[]') AS candidates
     FROM dynamic_ca_resolution_attempts attempt
     LEFT JOIN dynamic_asset_variants variant ON variant.id = attempt.selected_variant_id
     LEFT JOIN x_actor_dynamic_policies policy ON policy.id = attempt.actor_policy_id
     LEFT JOIN x_kol_accounts kol ON kol.id = policy.kol_id
     WHERE attempt.id = $1`, [Number(id)]
  );
  return result.rows[0] || null;
}

module.exports = { dbStatus, getById, list, persist };

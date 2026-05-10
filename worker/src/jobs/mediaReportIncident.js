import { request } from 'undici';
import { getServiceClient } from '@cairn/shared/supabase';

const REPORT_TIMEOUT_MS = 10_000;

/**
 * Pure-ish incident-reporting core.
 *
 * Stub mode (current): logs "would report" and timestamps reported_to_iwf_at
 * so the row reflects "queued for reporting" state honestly. When IWF
 * approval lands and IWF_REPORTING_URL is configured, the live path posts the
 * incident payload to the reporting endpoint.
 *
 * Idempotent: skips if reported_to_iwf_at is already non-null.
 *
 * @param {{ incident_id: string }} input
 * @param {{ supabase?: any, log?: any }} [options]
 */
export async function processMediaReportIncident(input, options = {}) {
  const { incident_id } = input || {};
  const log = options.log;
  const supabase = options.supabase ?? getServiceClient();

  if (!incident_id) throw new Error('incident_id missing from report payload');

  const { data: incident, error: readErr } = await supabase
    .from('incidents')
    .select('*')
    .eq('id', incident_id)
    .single();

  if (readErr || !incident) {
    throw new Error(`report-incident: incident ${incident_id} not found: ${readErr?.message || 'no row'}`);
  }

  if (incident.reported_to_iwf_at) {
    log?.info?.({ msg: 'report-incident:already-reported', incident_id, reported_at: incident.reported_to_iwf_at });
    return { incident_id, skipped: true };
  }

  const reportingUrl = process.env.IWF_REPORTING_URL;
  const reportingKey = process.env.IWF_REPORTING_API_KEY;

  if (!reportingUrl || !reportingKey) {
    // STUB MODE — Amanda's IWF approval still pending. We mark the row so the
    // dashboard can show "queued for reporting" honestly, and the row carries
    // the evidence retention window from the table default.
    log?.warn?.({
      msg: 'report-incident:stub-mode',
      incident_id,
      note: 'Would report to IWF/NCMEC. Live activation requires IWF_REPORTING_URL + IWF_REPORTING_API_KEY.',
    });

    const { error: updateErr } = await supabase
      .from('incidents')
      .update({ reported_to_iwf_at: new Date().toISOString() })
      .eq('id', incident_id);

    if (updateErr) {
      throw new Error(`report-incident: stub-mode update failed: ${updateErr.message}`);
    }

    return { incident_id, mode: 'stub', queued: true };
  }

  // LIVE MODE — scaffolded. Confirm payload shape against IWF/NCMEC docs
  // before flipping the env flag in production.
  log?.info?.({ msg: 'report-incident:live-start', incident_id });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REPORT_TIMEOUT_MS);
  let liveStatus = 0;
  try {
    const res = await request(reportingUrl, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'authorization': `Bearer ${reportingKey}`,
        'content-type': 'application/json',
        'accept': 'application/json',
      },
      body: JSON.stringify({
        type: incident.type,
        detected_at: incident.detected_at,
        hash_data: incident.hash_data,
        // user_id and stone_id intentionally NOT forwarded — we send hashes,
        // not identifiers. Confirm IWF's expected schema before going live.
      }),
    });
    liveStatus = res.statusCode;
    res.body.resume(); // drain
  } catch (err) {
    log?.error?.({ msg: 'report-incident:live-failed', incident_id, err });
    throw new Error(`report-incident: live submission failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (liveStatus < 200 || liveStatus >= 300) {
    throw new Error(`report-incident: IWF reporting returned ${liveStatus}`);
  }

  const { error: updateErr } = await supabase
    .from('incidents')
    .update({ reported_to_iwf_at: new Date().toISOString() })
    .eq('id', incident_id);

  if (updateErr) {
    log?.error?.({ msg: 'report-incident:live-update-failed', incident_id, err: updateErr });
  }

  log?.info?.({ msg: 'report-incident:live-done', incident_id, status: liveStatus });
  return { incident_id, mode: 'live', status: liveStatus };
}

/**
 * BullMQ wrapper for 'media-report-incident' jobs.
 */
export async function mediaReportIncident(job, log) {
  const jobLog = log.child({ jobId: job.id });
  return processMediaReportIncident(job.data, { log: jobLog });
}

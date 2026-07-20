const state = $getWorkflowStaticData('global');
state._credentials = state._credentials || {};
state._credentials.webhook_secret = '<WEBHOOK_SECRET_STALE_REDACTED>';
return [{ json: { set: true, len: state._credentials.webhook_secret.length }}];
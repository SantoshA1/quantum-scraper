const creds = $getWorkflowStaticData('global')._credentials || {};
return [{ json: {
  has_webhook_secret: !!creds.webhook_secret,
  length: (creds.webhook_secret || '').length,
  prefix: (creds.webhook_secret || '').slice(0, 8)
}}];
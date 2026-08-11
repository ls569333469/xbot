const PROCESS_ROLES = new Set(['all', 'ingestion', 'execution']);

function argumentRole(args = process.argv.slice(2)) {
  const argument = args.find((item) => String(item).startsWith('--role='));
  return argument ? String(argument).slice('--role='.length).trim().toLowerCase() : '';
}

function getProcessRole(options = {}) {
  const argument = argumentRole(options.args);
  const configured = String(options.envRole ?? process.env.XBOT_PROCESS_ROLE ?? '')
    .trim().toLowerCase();
  const production = String(options.nodeEnv ?? process.env.NODE_ENV ?? '')
    .trim().toLowerCase() === 'production';
  if (production && !argument && !configured) {
    const error = new Error('Production requires an explicit XBOT process role');
    error.code = 'PROCESS_ROLE_REQUIRED';
    throw error;
  }
  const role = argument || configured || 'all';
  if (!PROCESS_ROLES.has(role)) {
    const error = new Error(`XBOT process role is invalid: ${role || '(empty)'}`);
    error.code = 'PROCESS_ROLE_INVALID';
    throw error;
  }
  if (production && role === 'all') {
    const error = new Error('Production cannot run the combined all process role');
    error.code = 'PROCESS_ROLE_ALL_FORBIDDEN';
    throw error;
  }
  return role;
}

function roleCapabilities(role = getProcessRole()) {
  return {
    api: role === 'all' || role === 'execution',
    execution: role === 'all' || role === 'execution',
    ingestion: role === 'all' || role === 'ingestion'
  };
}

module.exports = { PROCESS_ROLES, argumentRole, getProcessRole, roleCapabilities };

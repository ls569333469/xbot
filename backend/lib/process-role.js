const PROCESS_ROLES = new Set(['all', 'ingestion', 'execution']);

function argumentRole(args = process.argv.slice(2)) {
  const argument = args.find((item) => String(item).startsWith('--role='));
  return argument ? String(argument).slice('--role='.length).trim().toLowerCase() : '';
}

function getProcessRole(options = {}) {
  const role = argumentRole(options.args)
    || String(options.envRole ?? process.env.XBOT_PROCESS_ROLE ?? 'all').trim().toLowerCase();
  if (!PROCESS_ROLES.has(role)) {
    const error = new Error(`XBOT process role is invalid: ${role || '(empty)'}`);
    error.code = 'PROCESS_ROLE_INVALID';
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

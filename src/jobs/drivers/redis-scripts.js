let keyFunction = `
local function cricket_key(...)
  return table.concat({...}, ':')
end
`;

let eventFunction = `
local function cricket_event(kind, envelope, timestamp, metadata)
  local event = {
    type = kind,
    envelopeId = envelope.id,
    jobName = envelope.name,
    queueName = envelope.queueName,
    timestamp = timestamp
  }

  if metadata then
    for key, value in pairs(metadata) do
      event[key] = value
    end
  end

  return cjson.encode(event)
end
`;

export let enqueueScript = `
${keyFunction}
local envelope_json = ARGV[1]
local envelope_id = ARGV[2]
local prefix = ARGV[3]
local ready_member = ARGV[4]
local priority_score = ARGV[5]
local available_score = ARGV[6]
local is_ready = ARGV[7] == '1'
local event_json = ARGV[8]
local queue_name = ARGV[9]
local has_duplicate = ARGV[10] == '1'
local has_slot = ARGV[11] == '1'

if redis.call('EXISTS', KEYS[1]) == 1 then
  return cjson.encode({ status = 'duplicate', id = envelope_id })
end

if has_slot then
  local slot_owner = redis.call('GET', KEYS[8])
  if slot_owner then
    return cjson.encode({ status = 'duplicate', id = slot_owner })
  end
end

if has_duplicate then
  local duplicate_owner = redis.call('GET', KEYS[7])
  if duplicate_owner then
    local owner_envelope = cricket_key(prefix, 'envelope', duplicate_owner)
    if redis.call('EXISTS', owner_envelope) == 1 then
      return cjson.encode({ status = 'duplicate', id = duplicate_owner })
    end

    redis.call('DEL', KEYS[7])
  end
end

redis.call('SET', KEYS[1], envelope_json)
redis.call('HSET', KEYS[2], 'status', is_ready and 'queued' or 'delayed', 'attempts', '0')

if is_ready then
  redis.call('ZADD', KEYS[3], priority_score, ready_member)
else
  redis.call('ZADD', KEYS[4], available_score, envelope_id)
end

redis.call('RPUSH', KEYS[5], event_json)
redis.call('RPUSH', KEYS[6], queue_name)
redis.call('PUBLISH', KEYS[6], queue_name)

if has_duplicate then
  redis.call('SET', KEYS[7], envelope_id)
end

if has_slot then
  redis.call('SET', KEYS[8], envelope_id)
end

return cjson.encode({ status = 'enqueued', id = envelope_id })
`;

export let claimScript = `
${keyFunction}
${eventFunction}
local prefix = ARGV[1]
local timestamp = ARGV[2]
local lease_seconds = ARGV[3]
local id = ARGV[4]
local ready_member = ARGV[5]

if not redis.call('ZSCORE', KEYS[2], ready_member) then
  return cjson.encode({ status = 'lost' })
end

local envelope_json = redis.call('GET', KEYS[3])
if not envelope_json then
  redis.call('ZREM', KEYS[2], ready_member)
  return cjson.encode({ status = 'missing' })
end

local envelope = cjson.decode(envelope_json)

local function matching_constraints(envelope, constraint)
  local matches = {}
  for _, candidate in ipairs(envelope.concurrency or {}) do
    if candidate.type == constraint.type and candidate.key == constraint.key then
      table.insert(matches, candidate)
    end
  end
  return matches
end

local function has_capacity(envelope)
  if #(envelope.concurrency or {}) == 0 then
    return true
  end

  local active = {}
  local active_ids = redis.call('SMEMBERS', KEYS[1])

  for _, active_id in ipairs(active_ids) do
    local text = redis.call('GET', cricket_key(prefix, 'envelope', active_id))
    if text then
      table.insert(active, cjson.decode(text))
    else
      redis.call('SREM', KEYS[1], active_id)
    end
  end

  for _, constraint in ipairs(envelope.concurrency or {}) do
    local count = 0
    local limit = constraint.limit

    for _, active_envelope in ipairs(active) do
      local matches = matching_constraints(active_envelope, constraint)
      if #matches > 0 then
        count = count + 1
        for _, match in ipairs(matches) do
          if match.limit < limit then
            limit = match.limit
          end
        end
      end
    end

    if count >= limit then
      return false
    end
  end

  return true
end

if not has_capacity(envelope) then
  return cjson.encode({ status = 'blocked' })
end

if redis.call('ZREM', KEYS[2], ready_member) ~= 1 then
  return cjson.encode({ status = 'lost' })
end

local attempt = redis.call('HINCRBY', KEYS[4], 'attempts', 1)

redis.call('SADD', KEYS[1], id)
redis.call('DEL', KEYS[7], KEYS[8], KEYS[9])
redis.call('HSET', KEYS[4], 'status', 'active', 'startedAt', timestamp, 'lastHeartbeatAt', timestamp)
redis.call('SET', KEYS[5], tostring(attempt), 'EX', lease_seconds)
redis.call('RPUSH', KEYS[6], cricket_event('claimed', envelope, timestamp, { attempt = attempt }))

return cjson.encode({ status = 'claimed', attempt = attempt, envelope = envelope })
`;

export let settleScript = `
local id = ARGV[1]
local attempt = ARGV[2]
local status = ARGV[3]
local value_field = ARGV[4]
local value_json = ARGV[5]
local event_json = ARGV[6]
local has_duplicate = ARGV[7] == '1'
local allow_expired_lease = ARGV[8] == '1'

if redis.call('HGET', KEYS[2], 'status') ~= 'active' then
  return 0
end

if redis.call('HGET', KEYS[2], 'attempts') ~= attempt then
  return 0
end

local lease_owner = redis.call('GET', KEYS[3])
if allow_expired_lease then
  if lease_owner == attempt then
    return 0
  end
elseif lease_owner ~= attempt then
  return 0
end

if redis.call('SREM', KEYS[1], id) ~= 1 then
  return 0
end

redis.call('HSET', KEYS[2], 'status', status, value_field, value_json)
redis.call('DEL', KEYS[3])

if has_duplicate and redis.call('GET', KEYS[5]) == id then
  redis.call('DEL', KEYS[5])
end

redis.call('RPUSH', KEYS[4], event_json)
return 1
`;

export let retryScript = `
local id = ARGV[1]
local attempt = ARGV[2]
local ready_member = ARGV[3]
local priority_score = ARGV[4]
local available_score = ARGV[5]
local available_at = ARGV[6]
local is_ready = ARGV[7] == '1'
local event_json = ARGV[8]
local queue_name = ARGV[9]
local allow_expired_lease = ARGV[10] == '1'

if redis.call('HGET', KEYS[2], 'status') ~= 'active' then
  return 0
end

if redis.call('HGET', KEYS[2], 'attempts') ~= attempt then
  return 0
end

local lease_owner = redis.call('GET', KEYS[3])
if allow_expired_lease then
  if lease_owner == attempt then
    return 0
  end
elseif lease_owner ~= attempt then
  return 0
end

if redis.call('SREM', KEYS[1], id) ~= 1 then
  return 0
end

redis.call('HSET', KEYS[2], 'status', is_ready and 'queued' or 'delayed', 'availableAt', available_at)
redis.call('DEL', KEYS[3])

if is_ready then
  redis.call('ZADD', KEYS[4], priority_score, ready_member)
else
  redis.call('ZADD', KEYS[5], available_score, id)
end

redis.call('RPUSH', KEYS[6], event_json)
redis.call('RPUSH', KEYS[7], queue_name)
redis.call('PUBLISH', KEYS[7], queue_name)
return 1
`;

export let heartbeatScript = `
local id = ARGV[1]
local attempt = ARGV[2]
local timestamp = ARGV[3]
local lease_seconds = ARGV[4]

if redis.call('HGET', KEYS[2], 'status') ~= 'active' or redis.call('HGET', KEYS[2], 'attempts') ~= attempt then
  return 0
end

if redis.call('SISMEMBER', KEYS[1], id) ~= 1 then
  return 0
end

if redis.call('GET', KEYS[3]) ~= attempt then
  return 0
end

redis.call('HSET', KEYS[2], 'lastHeartbeatAt', timestamp)
redis.call('SET', KEYS[3], attempt, 'EX', lease_seconds)
return 1
`;

export let progressScript = `
local id = ARGV[1]
local attempt = ARGV[2]

if redis.call('HGET', KEYS[2], 'status') ~= 'active' or redis.call('HGET', KEYS[2], 'attempts') ~= attempt then
  return 0
end

if redis.call('SISMEMBER', KEYS[1], id) ~= 1 then
  return 0
end

if redis.call('GET', KEYS[5]) ~= attempt then
  return 0
end

redis.call('RPUSH', KEYS[3], ARGV[3])
redis.call('RPUSH', KEYS[4], ARGV[4])
return 1
`;

export let evidenceScript = `
local id = ARGV[1]
local attempt = ARGV[2]

if redis.call('HGET', KEYS[2], 'status') ~= 'active' or redis.call('HGET', KEYS[2], 'attempts') ~= attempt then
  return 0
end

if redis.call('SISMEMBER', KEYS[1], id) ~= 1 then
  return 0
end

if redis.call('GET', KEYS[4]) ~= attempt then
  return 0
end

redis.call('RPUSH', KEYS[3], ARGV[3])
return 1
`;

export let recoveryHeaderScript = `
local id = ARGV[1]

local function hash_value(values)
  local result = {}
  for index = 1, #values, 2 do
    result[values[index]] = values[index + 1]
  end
  return result
end

if redis.call('SISMEMBER', KEYS[1], id) ~= 1 then
  return nil
end

local envelope_text = redis.call('GET', KEYS[2])
if not envelope_text then
  redis.call('SREM', KEYS[1], id)
  return nil
end

local run = hash_value(redis.call('HGETALL', KEYS[3]))
local candidate = {
  envelope = cjson.decode(envelope_text),
  attempt = tonumber(run.attempts or '0'),
  status = run.status,
  leaseActive = redis.call('GET', KEYS[4]) == run.attempts,
  ledger = {
    status = run.status,
    attempts = tonumber(run.attempts or '0')
  }
}

if run.startedAt then
  candidate.startedAt = run.startedAt
  candidate.ledger.startedAt = run.startedAt
end
if run.lastHeartbeatAt then
  candidate.lastHeartbeatAt = run.lastHeartbeatAt
  candidate.ledger.updatedAt = run.lastHeartbeatAt
end
if run.error then
  candidate.ledger.error = cjson.decode(run.error)
end

return cjson.encode(candidate)
`;

export let promoteDelayedScript = `
${keyFunction}
${eventFunction}
local prefix = ARGV[1]
local now_score = ARGV[2]
local timestamp = ARGV[3]
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now_score, 'LIMIT', 0, 100)
local promoted = {}

for _, id in ipairs(ids) do
  if redis.call('ZREM', KEYS[1], id) == 1 then
    local text = redis.call('GET', cricket_key(prefix, 'envelope', id))
    if text then
      local envelope = cjson.decode(text)
      local ready_key = cricket_key(prefix, 'ready', envelope.queueName)
      local ready_member = cjson.encode({ envelope.createdAt, envelope.id })
      local priority_score = 0 - (envelope.priority or 0)

      redis.call('HSET', cricket_key(prefix, 'run', id), 'status', 'queued')
      redis.call('ZADD', ready_key, priority_score, ready_member)
      redis.call('RPUSH', cricket_key(prefix, 'events', id), cricket_event('delay_promoted', envelope, timestamp))
      redis.call('RPUSH', KEYS[2], envelope.queueName)
      redis.call('PUBLISH', KEYS[2], envelope.queueName)
      table.insert(promoted, envelope)
    end
  end
end

return cjson.encode(promoted)
`;

export let registerScheduleScript = `
local existing_text = redis.call('GET', KEYS[1])
local existing = existing_text and cjson.decode(existing_text) or {}
local contract = cjson.decode(ARGV[1])

existing.key = contract.key
existing.jobName = contract.jobName
existing.cron = contract.cron
existing.timezone = contract.timezone
existing.enabled = contract.enabled
existing.runOnStartup = contract.runOnStartup

if existing.lastRunAt == nil and contract.lastRunAt ~= nil then
  existing.lastRunAt = contract.lastRunAt
end

if contract.nextRunAt ~= nil then
  existing.nextRunAt = contract.nextRunAt
end

local result = cjson.encode(existing)
redis.call('SET', KEYS[1], result)
return result
`;

export let updateScheduleScript = `
local existing_text = redis.call('GET', KEYS[1])
local existing = existing_text and cjson.decode(existing_text) or cjson.decode(ARGV[1])
local values = cjson.decode(ARGV[2])

for key, value in pairs(values) do
  existing[key] = value
end

local result = cjson.encode(existing)
redis.call('SET', KEYS[1], result)
return result
`;

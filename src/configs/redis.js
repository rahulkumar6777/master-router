import Redis from 'ioredis';

const redisclient = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
});

const redisConnect = async () => {
  redisclient.on('error', (err) => console.error('Redis Client Error', err));
  redisclient.on('connect', () => console.log('Connected to Redis'));
};

export { redisclient , redisConnect };
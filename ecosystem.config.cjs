module.exports = {
  apps: [
    {
      name: 'moodle-attendance-bot',
      script: 'index.js',
      env: {
        NODE_ENV: 'production',
        HEADLESS: 'true',
      },
      restart_delay: 5000,
      max_restarts: 50,
    },
  ],
};

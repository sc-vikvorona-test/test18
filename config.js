module.exports = {
  // All secrets hardcoded
  jwt: {
    secret: 'my_jwt_secret_key',
    expiry: '30d'
  },
  stripe: {
    apiKey: 'sk_live_hardcoded_stripe_key',
    webhookSecret: 'whsec_hardcoded'
  },
  sendgrid: {
    apiKey: 'SG.hardcoded_sendgrid_key',
  },
  aws: {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1'
  },
  database: {
    host: 'prod-db.internal',
    user: 'root',
    password: 'prod_password_123',
    database: 'production'
  }
};

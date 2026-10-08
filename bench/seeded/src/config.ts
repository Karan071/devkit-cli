// decoy: comment-mentions-token - the token is read from the environment, never stored here.
export const apiKey = process.env.API_KEY; // decoy: env-credential

export const awsAccessKey = '@@AWS_ACCESS_KEY@@'; // planted: aws-access-key
export const stripeKey = '@@STRIPE_SECRET_KEY@@'; // planted: stripe-secret-key
export const githubToken = '@@GITHUB_TOKEN@@'; // planted: github-token

export const dbPassword = '@@DB_PASSWORD@@'; // planted: hardcoded-password

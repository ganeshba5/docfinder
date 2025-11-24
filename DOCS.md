# DocFinder API Documentation

## Table of Contents
- [Authentication](#authentication)
- [API Endpoints](#api-endpoints)
  - [Token Management](#token-management)
  - [Account Management](#account-management)
- [Token Management](#token-management-1)
  - [Storage](#storage)
  - [Operations](#operations)
  - [Error Handling](#error-handling)
- [Authentication Flow](#authentication-flow)
- [Security](#security)
- [Error Reference](#error-reference)

## Authentication

DocFinder uses OAuth 2.0 for authentication with providers (Google, Microsoft). Tokens are securely stored in the system keychain.

## API Endpoints

### Token Management

#### Check Token Status
- **Endpoint**: `GET /api/accounts/token/:provider/:alias`
- **Description**: Check token status for a provider and alias
- **Parameters**:
  - `provider` (path): Authentication provider (e.g., 'google', 'microsoft')
  - `alias` (path): Account alias
- **Response**:
  ```json
  {
    "hasValidToken": true,
    "expiresAt": "2023-01-01T00:00:00.000Z",
    "provider": "microsoft",
    "alias": "user@example.com"
  }
  ```

#### Delete Tokens
- **Endpoint**: `DELETE /api/accounts/token/:provider/:alias`
- **Description**: Delete tokens for a provider and alias
- **Parameters**:
  - `provider` (path): Authentication provider
  - `alias` (path): Account alias
- **Response**:
  ```json
  {
    "success": true
  }
  ```

### Account Management

#### Save Account Configuration
- **Endpoint**: `POST /api/accounts`
- **Description**: Save or update account configuration
- **Request Body**:
  ```json
  {
    "provider": "microsoft",
    "alias": "user@example.com",
    "clientId": "your-client-id",
    "clientSecret": "your-client-secret",
    "tenantId": "your-tenant-id"  // Microsoft specific
  }
  ```
- **Response**:
  ```json
  {
    "success": true
  }
  ```

#### Delete Account
- **Endpoint**: `DELETE /api/accounts/:provider/:alias`
- **Description**: Delete an account and its tokens
- **Parameters**:
  - `provider` (path): Authentication provider
  - `alias` (path): Account alias
- **Response**:
  ```json
  {
    "success": true
  }
  ```

## Token Management

### Storage
- **Location**: System keychain (macOS) / Credential Vault (Windows)
- **Service Name**: `docfinder`
- **Key Format**: `{provider}:{alias}`
- **Token Structure**:
  ```javascript
  {
    "access_token": "string",  // OAuth access token
    "refresh_token": "string", // OAuth refresh token
    "expires_at": 1672531200,   // Unix timestamp
    "token_type": "Bearer",    // Token type
    "scope": "user.read",      // Authorized scopes
    "last_updated": "2023-01-01T00:00:00.000Z"
  }
  ```

### Operations

#### Get Tokens
```javascript
/**
 * Retrieves tokens for a provider and alias
 * @param {string} provider - Authentication provider
 * @param {string} alias - Account alias
 * @returns {Promise<Object|null>} Token object or null if not found
 */
```

#### Save Tokens
```javascript
/**
 * Saves tokens for a provider and alias
 * @param {string} provider - Authentication provider
 * @param {string} alias - Account alias
 * @param {Object} tokens - Token object
 * @returns {Promise<boolean>} Success status
 */
```

#### Delete Tokens
```javascript
/**
 * Deletes tokens for a provider and alias
 * @param {string} provider - Authentication provider
 * @param {string} alias - Account alias
 * @returns {Promise<boolean>} Success status
 */
```

### Error Handling
- **Missing Tokens**: Returns `null`
- **Invalid Tokens**: Logs error and returns `null`
- **Storage Errors**: Throws error with details

## Authentication Flow

1. User initiates OAuth flow via `/auth/{provider}?alias={alias}`
2. User authenticates with provider
3. Provider redirects to `/auth/{provider}/callback` with auth code
4. Server exchanges code for tokens
5. Tokens are stored using `saveTokens()`
6. User is redirected back to the application

## Security

- Tokens are stored in the system keychain
- All API endpoints validate input parameters
- Sensitive operations require confirmation
- Token operations are logged at debug level

## Error Reference

| Code | Message | Description |
|------|---------|-------------|
| 400 | Missing required parameters | Required parameters are missing |
| 400 | Invalid provider | Unsupported authentication provider |
| 401 | Unauthorized | Invalid or expired token |
| 404 | Account not found | Specified account does not exist |
| 500 | Internal server error | An unexpected error occurred |

## Rate Limiting

- 100 requests per minute per IP address
- 1000 requests per hour per user

## Versioning

API versioning is handled through the `Accept` header:

```
Accept: application/vnd.docfinder.v1+json
```

## Support

For support, please contact [support email] or open an issue on our [GitHub repository].

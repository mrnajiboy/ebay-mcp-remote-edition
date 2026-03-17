import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import * as jose from 'jose';
import { TokenVerifier } from '@/auth/token-verifier.js';
import type { OAuthServerMetadata } from '@/auth/oauth-types.js';

vi.mock('axios');
vi.mock('jose');

describe('TokenVerifier', () => {
  const mockMetadata: OAuthServerMetadata = {
    issuer: 'http://localhost:8080/realms/master',
    authorization_endpoint: 'http://localhost:8080/realms/master/protocol/openid-connect/auth',
    token_endpoint: 'http://localhost:8080/realms/master/protocol/openid-connect/token',
    jwks_uri: 'http://localhost:8080/realms/master/protocol/openid-connect/certs',
    introspection_endpoint:
      'http://localhost:8080/realms/master/protocol/openid-connect/token/introspect',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('initialize', () => {
    it('should load metadata from URL', async () => {
      vi.mocked(axios.get).mockResolvedValue({ data: mockMetadata });

      const verifier = new TokenVerifier({
        authServerMetadata: 'http://localhost:8080/realms/master/.well-known/openid-configuration',
        expectedAudience: 'http://localhost:3000',
      });

      await verifier.initialize();

      expect(axios.get).toHaveBeenCalledWith(
        'http://localhost:8080/realms/master/.well-known/openid-configuration'
      );
    });

    it('should use provided metadata object', async () => {
      const verifier = new TokenVerifier({
        authServerMetadata: mockMetadata,
        expectedAudience: 'http://localhost:3000',
      });

      await verifier.initialize();

      expect(axios.get).not.toHaveBeenCalled();
    });

    it('should throw error if metadata loading fails', async () => {
      vi.mocked(axios.get).mockRejectedValue(new Error('Network error'));

      const verifier = new TokenVerifier({
        authServerMetadata: 'http://localhost:8080/realms/master/.well-known/openid-configuration',
        expectedAudience: 'http://localhost:3000',
      });

      await expect(verifier.initialize()).rejects.toThrow(
        'Failed to load OAuth server metadata: Network error'
      );
    });
  });

  describe('verifyToken - introspection', () => {
    it('should verify token via introspection', async () => {
      vi.mocked(axios.get).mockResolvedValue({ data: mockMetadata });
      vi.mocked(axios.post).mockResolvedValue({
        data: {
          active: true,
          client_id: 'test-client',
          scope: 'mcp:tools mcp:admin',
          exp: Math.floor(Date.now() / 1000) + 3600,
          aud: 'http://localhost:3000',
          sub: 'user123',
        },
      });

      const verifier = new TokenVerifier({
        authServerMetadata: 'http://localhost:8080/.well-known/openid-configuration',
        expectedAudience: 'http://localhost:3000',
        clientId: 'mcp-server',
        clientSecret: 'secret',
        requiredScopes: ['mcp:tools'],
        useIntrospection: true,
      });

      await verifier.initialize();
      const result = await verifier.verifyToken('test-token');

      expect(result).toMatchObject({
        token: 'test-token',
        clientId: 'test-client',
        scopes: ['mcp:tools', 'mcp:admin'],
        audience: 'http://localhost:3000',
        subject: 'user123',
      });

      expect(axios.post).toHaveBeenCalledWith(
        mockMetadata.introspection_endpoint,
        expect.any(URLSearchParams),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
    });

    it('should reject inactive tokens', async () => {
      vi.mocked(axios.get).mockResolvedValue({ data: mockMetadata });
      vi.mocked(axios.post).mockResolvedValue({
        data: {
          active: false,
        },
      });

      const verifier = new TokenVerifier({
        authServerMetadata: mockMetadata,
        expectedAudience: 'http://localhost:3000',
        useIntrospection: true,
      });

      await verifier.initialize();

      await expect(verifier.verifyToken('invalid-token')).rejects.toThrow('Token is not active');
    });

    it('should reject tokens with invalid audience', async () => {
      vi.mocked(axios.get).mockResolvedValue({ data: mockMetadata });
      vi.mocked(axios.post).mockResolvedValue({
        data: {
          active: true,
          aud: 'http://different-server:3000',
          scope: 'mcp:tools',
        },
      });

      const verifier = new TokenVerifier({
        authServerMetadata: mockMetadata,
        expectedAudience: 'http://localhost:3000',
        useIntrospection: true,
      });

      await verifier.initialize();

      await expect(verifier.verifyToken('test-token')).rejects.toThrow(/Invalid audience/);
    });

    it('should reject tokens with missing scopes', async () => {
      vi.mocked(axios.get).mockResolvedValue({ data: mockMetadata });
      vi.mocked(axios.post).mockResolvedValue({
        data: {
          active: true,
          aud: 'http://localhost:3000',
          scope: 'mcp:tools',
        },
      });

      const verifier = new TokenVerifier({
        authServerMetadata: mockMetadata,
        expectedAudience: 'http://localhost:3000',
        requiredScopes: ['mcp:admin', 'mcp:superuser'],
        useIntrospection: true,
      });

      await verifier.initialize();

      await expect(verifier.verifyToken('test-token')).rejects.toThrow(/Missing required scopes/);
    });

    it('should handle introspection endpoint errors', async () => {
      vi.mocked(axios.get).mockResolvedValue({ data: mockMetadata });
      vi.mocked(axios.post).mockRejectedValue({
        isAxiosError: true,
        response: {
          data: {
            error_description: 'Invalid token',
          },
        },
      });

      vi.mocked(axios.isAxiosError).mockReturnValue(true);

      const verifier = new TokenVerifier({
        authServerMetadata: mockMetadata,
        expectedAudience: 'http://localhost:3000',
        useIntrospection: true,
      });

      await verifier.initialize();

      await expect(verifier.verifyToken('test-token')).rejects.toThrow(
        'Token introspection failed: Invalid token'
      );
    });

    it('should throw error if introspection endpoint not available', async () => {
      const metadataWithoutIntrospection = {
        issuer: 'http://localhost:8080/realms/master',
        authorization_endpoint: 'http://localhost:8080/realms/master/protocol/openid-connect/auth',
        token_endpoint: 'http://localhost:8080/realms/master/protocol/openid-connect/token',
        jwks_uri: 'http://localhost:8080/realms/master/protocol/openid-connect/certs',
      };

      const verifier = new TokenVerifier({
        authServerMetadata: metadataWithoutIntrospection,
        expectedAudience: 'http://localhost:3000',
        useIntrospection: true,
      });

      await verifier.initialize();

      await expect(verifier.verifyToken('test-token')).rejects.toThrow(
        'Introspection endpoint not available'
      );
    });
  });

  describe('verifyToken - JWT', () => {
    it('should verify token via JWT validation', async () => {
      const mockJWKS = vi.fn();
      const mockPayload = {
        iss: mockMetadata.issuer,
        aud: 'http://localhost:3000',
        sub: 'user123',
        client_id: 'test-client',
        scope: 'mcp:tools mcp:admin',
        exp: Math.floor(Date.now() / 1000) + 3600,
      };

      vi.mocked(axios.get).mockResolvedValue({ data: mockMetadata });
      vi.mocked(jose.createRemoteJWKSet).mockReturnValue(mockJWKS as any);
      vi.mocked(jose.jwtVerify).mockResolvedValue({
        payload: mockPayload,
        protectedHeader: {} as any,
      });

      const verifier = new TokenVerifier({
        authServerMetadata: mockMetadata,
        expectedAudience: 'http://localhost:3000',
        requiredScopes: ['mcp:tools'],
        useIntrospection: false,
      });

      await verifier.initialize();
      const result = await verifier.verifyToken('test-jwt-token');

      expect(result).toMatchObject({
        token: 'test-jwt-token',
        clientId: 'test-client',
        scopes: ['mcp:tools', 'mcp:admin'],
        subject: 'user123',
      });

      expect(jose.jwtVerify).toHaveBeenCalledWith('test-jwt-token', mockJWKS, {
        issuer: mockMetadata.issuer,
        audience: 'http://localhost:3000',
      });
    });

    it('should handle scope as array in JWT', async () => {
      const mockJWKS = vi.fn();
      const mockPayload = {
        iss: mockMetadata.issuer,
        aud: 'http://localhost:3000',
        scope: ['mcp:tools', 'mcp:admin'],
        client_id: 'test-client',
        exp: Math.floor(Date.now() / 1000) + 3600,
      };

      vi.mocked(axios.get).mockResolvedValue({ data: mockMetadata });
      vi.mocked(jose.createRemoteJWKSet).mockReturnValue(mockJWKS as any);
      vi.mocked(jose.jwtVerify).mockResolvedValue({
        payload: mockPayload,
        protectedHeader: {} as any,
      });

      const verifier = new TokenVerifier({
        authServerMetadata: mockMetadata,
        expectedAudience: 'http://localhost:3000',
        useIntrospection: false,
      });

      await verifier.initialize();
      const result = await verifier.verifyToken('test-jwt-token');

      expect(result.scopes).toEqual(['mcp:tools', 'mcp:admin']);
    });

    it('should reject JWT with missing scopes', async () => {
      const mockJWKS = vi.fn();
      const mockPayload = {
        iss: mockMetadata.issuer,
        aud: 'http://localhost:3000',
        scope: 'mcp:tools',
        client_id: 'test-client',
        exp: Math.floor(Date.now() / 1000) + 3600,
      };

      vi.mocked(axios.get).mockResolvedValue({ data: mockMetadata });
      vi.mocked(jose.createRemoteJWKSet).mockReturnValue(mockJWKS as any);
      vi.mocked(jose.jwtVerify).mockResolvedValue({
        payload: mockPayload,
        protectedHeader: {} as any,
      });

      const verifier = new TokenVerifier({
        authServerMetadata: mockMetadata,
        expectedAudience: 'http://localhost:3000',
        requiredScopes: ['mcp:admin'],
        useIntrospection: false,
      });

      await verifier.initialize();

      await expect(verifier.verifyToken('test-jwt-token')).rejects.toThrow(
        /Missing required scopes/
      );
    });

    it('should throw error if JWKS URI not available', async () => {
      const metadataWithoutJWKS = {
        issuer: 'http://localhost:8080/realms/master',
        authorization_endpoint: 'http://localhost:8080/realms/master/protocol/openid-connect/auth',
        token_endpoint: 'http://localhost:8080/realms/master/protocol/openid-connect/token',
      };

      const verifier = new TokenVerifier({
        authServerMetadata: metadataWithoutJWKS as OAuthServerMetadata,
        expectedAudience: 'http://localhost:3000',
        useIntrospection: false,
      });

      await verifier.initialize();

      await expect(verifier.verifyToken('test-token')).rejects.toThrow('JWKS URI not available');
    });

    it('should handle JWT verification failures', async () => {
      vi.mocked(axios.get).mockResolvedValue({ data: mockMetadata });
      vi.mocked(jose.createRemoteJWKSet).mockReturnValue(vi.fn() as any);
      vi.mocked(jose.jwtVerify).mockRejectedValue(new Error('Invalid signature'));

      const verifier = new TokenVerifier({
        authServerMetadata: mockMetadata,
        expectedAudience: 'http://localhost:3000',
        useIntrospection: false,
      });

      await verifier.initialize();

      await expect(verifier.verifyToken('invalid-jwt')).rejects.toThrow(
        'JWT verification failed: Invalid signature'
      );
    });

    it('should use azp claim if client_id not present', async () => {
      const mockJWKS = vi.fn();
      const mockPayload = {
        iss: mockMetadata.issuer,
        aud: 'http://localhost:3000',
        azp: 'authorized-party-client',
        scope: 'mcp:tools',
        exp: Math.floor(Date.now() / 1000) + 3600,
      };

      vi.mocked(axios.get).mockResolvedValue({ data: mockMetadata });
      vi.mocked(jose.createRemoteJWKSet).mockReturnValue(mockJWKS as any);
      vi.mocked(jose.jwtVerify).mockResolvedValue({
        payload: mockPayload,
        protectedHeader: {} as any,
      });

      const verifier = new TokenVerifier({
        authServerMetadata: mockMetadata,
        expectedAudience: 'http://localhost:3000',
        useIntrospection: false,
      });

      await verifier.initialize();
      const result = await verifier.verifyToken('test-jwt-token');

      expect(result.clientId).toBe('authorized-party-client');
    });
  });

  describe('validateAudience', () => {
    it('should validate audience with trailing slash normalization', async () => {
      vi.mocked(axios.get).mockResolvedValue({ data: mockMetadata });
      vi.mocked(axios.post).mockResolvedValue({
        data: {
          active: true,
          aud: 'http://localhost:3000/',
          scope: 'mcp:tools',
        },
      });

      const verifier = new TokenVerifier({
        authServerMetadata: mockMetadata,
        expectedAudience: 'http://localhost:3000',
        useIntrospection: true,
      });

      await verifier.initialize();
      const result = await verifier.verifyToken('test-token');

      expect(result).toBeDefined();
    });

    it('should validate audience array', async () => {
      vi.mocked(axios.get).mockResolvedValue({ data: mockMetadata });
      vi.mocked(axios.post).mockResolvedValue({
        data: {
          active: true,
          aud: ['http://localhost:3000', 'http://example.com'],
          scope: 'mcp:tools',
        },
      });

      const verifier = new TokenVerifier({
        authServerMetadata: mockMetadata,
        expectedAudience: 'http://localhost:3000',
        useIntrospection: true,
      });

      await verifier.initialize();
      const result = await verifier.verifyToken('test-token');

      expect(result).toBeDefined();
    });
  });

  describe('verifyToken - not initialized', () => {
    it('should throw error if verify token is called before initialization', async () => {
      const verifier = new TokenVerifier({
        authServerMetadata: mockMetadata,
        expectedAudience: 'http://localhost:3000',
      });

      await expect(verifier.verifyToken('test-token')).rejects.toThrow(
        'Token verifier not initialized'
      );
    });
  });
});

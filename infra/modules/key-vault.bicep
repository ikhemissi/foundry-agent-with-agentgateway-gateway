targetScope = 'resourceGroup'

param location string
param tags object
param suffix string
param principalId string
param gatewayPrincipalId string
param workspaceId string

@secure()
param gatewayApiKey string

resource vault 'Microsoft.KeyVault/vaults@2024-11-01' = {
  name: 'kv-agw-${suffix}'
  location: location
  tags: tags
  properties: {
    tenantId: tenant().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
    accessPolicies: []
  }
}

resource apiKey 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = {
  parent: vault
  name: 'agentgateway-api-key'
  tags: tags
  properties: {
    value: gatewayApiKey
    contentType: 'agentgateway inference bearer credential'
  }
}

resource gatewaySecretAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(apiKey.id, gatewayPrincipalId, 'Key Vault Secrets User')
  scope: apiKey
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
    principalId: gatewayPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource deployerSecretsOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, principalId, 'Key Vault Secrets Officer')
  scope: vault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7')
    principalId: principalId
    principalType: 'User'
  }
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'shared-monitoring'
  scope: vault
  properties: {
    workspaceId: workspaceId
    logs: [
      { category: 'AuditEvent', enabled: true }
      { category: 'AzurePolicyEvaluationDetails', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

output name string = vault.name
output apiKeySecretUri string = '${vault.properties.vaultUri}secrets/${apiKey.name}'

targetScope = 'resourceGroup'

@minLength(36)
@maxLength(36)
@description('Hosted agent instance identity, available only after deployment.')
param agentPrincipalId string
param keyVaultName string
param appInsightsName string
param grantSecretRead bool = true

resource vault 'Microsoft.KeyVault/vaults@2024-11-01' existing = {
  name: keyVaultName
}

resource gatewayKey 'Microsoft.KeyVault/vaults/secrets@2024-11-01' existing = {
  parent: vault
  name: 'agentgateway-api-key'
}

resource insights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: appInsightsName
}

resource secretReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (grantSecretRead) {
  name: guid(gatewayKey.id, agentPrincipalId, 'Key Vault Secrets User')
  scope: gatewayKey
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
    principalId: agentPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource telemetryPublisher 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(insights.id, agentPrincipalId, 'Monitoring Metrics Publisher')
  scope: insights
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '3913510d-42f4-4e42-8a64-420c390055eb')
    principalId: agentPrincipalId
    principalType: 'ServicePrincipal'
  }
}

targetScope = 'resourceGroup'

@minLength(36)
@maxLength(36)
@description('Hosted agent instance identity, available only after deployment.')
param agentPrincipalId string
param appInsightsName string

resource insights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: appInsightsName
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

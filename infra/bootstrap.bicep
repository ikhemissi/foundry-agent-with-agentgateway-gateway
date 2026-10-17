targetScope = 'subscription'

@minLength(1)
@maxLength(50)
param environmentName string
param principalId string

@allowed([
  'eastus'
  'uksouth'
  'swedencentral'
])
param location string = 'eastus'
param tags object = {}

var resourceTags = union(tags, {
  'azd-env-name': environmentName
})

resource resourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-${environmentName}'
  location: location
  tags: resourceTags
}

var suffix = uniqueString(subscription().id, resourceGroup.id, 'agentgateway')

module resourceGroupAccess './modules/resource-group-access.bicep' = {
  name: 'resource-group-access'
  scope: resourceGroup
  params: {
    principalId: principalId
  }
}

module identity './modules/identity.bicep' = {
  name: 'gateway-identity'
  scope: resourceGroup
  params: {
    location: location
    tags: resourceTags
    suffix: suffix
  }
}

module monitoring './modules/monitoring.bicep' = {
  name: 'shared-monitoring'
  scope: resourceGroup
  params: {
    location: location
    tags: resourceTags
    suffix: suffix
    principalId: principalId
    gatewayPrincipalId: identity.outputs.principalId
  }
}

module keyVault './modules/key-vault.bicep' = {
  name: 'gateway-key-vault'
  scope: resourceGroup
  params: {
    location: location
    tags: resourceTags
    suffix: suffix
    principalId: principalId
    workspaceId: monitoring.outputs.workspaceId
  }
}

output resourceGroupName string = resourceGroup.name
output keyVaultName string = keyVault.outputs.name

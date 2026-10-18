targetScope = 'resourceGroup'

extension microsoftGraphV1

param environmentName string
param applicationUniqueName string
param redirectUris array
param blueprintClientId string
param blueprintPrincipalId string
param userScopeId string
param userScopeName string
param authorizedUserId string

resource application 'Microsoft.Graph/applications@v1.0' = {
  uniqueName: applicationUniqueName
  displayName: '${environmentName}-copilotkit-demo'
  signInAudience: 'AzureADMyOrg'
  spa: {
    redirectUris: redirectUris
  }
  requiredResourceAccess: [
    {
      resourceAppId: blueprintClientId
      resourceAccess: [
        {
          id: userScopeId
          type: 'Scope'
        }
      ]
    }
  ]
}

resource principal 'Microsoft.Graph/servicePrincipals@v1.0' = {
  appId: application.appId
}

resource userConsent 'Microsoft.Graph/oauth2PermissionGrants@v1.0' = {
  clientId: principal.id
  resourceId: blueprintPrincipalId
  consentType: 'Principal'
  principalId: authorizedUserId
  scope: userScopeName
}

output clientId string = application.appId
output principalId string = principal.id

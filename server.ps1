param(
  [ValidateRange(1024, 65535)]
  [int]$Port = 5080
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$dataDirectory = Join-Path $root "App_Data"
$ordersPath = Join-Path $dataDirectory "orders.json"
$maxBodyBytes = 16384
$adminUsername = if ([string]::IsNullOrWhiteSpace($env:KHEJUR_ADMIN_USER)) { "admin" } else { $env:KHEJUR_ADMIN_USER }
$adminPassword = $env:KHEJUR_ADMIN_PASSWORD

if ([string]::IsNullOrWhiteSpace($adminPassword)) {
  $securePassword = Read-Host "Admin password (minimum 12 characters)" -AsSecureString
  $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
  try {
    $adminPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
  }
}

if ($adminPassword.Length -lt 12) {
  throw "Admin password must contain at least 12 characters."
}

New-Item -ItemType Directory -Force -Path $dataDirectory | Out-Null
if (-not (Test-Path -LiteralPath $ordersPath)) {
  [System.IO.File]::WriteAllText($ordersPath, "[]", (New-Object System.Text.UTF8Encoding($false)))
}

$products = @{
  ajwa    = @{ name = "আজওয়া"; weight = "৫০০ গ্রাম"; price = 1250 }
  medjool = @{ name = "মেডজুল"; weight = "৫০০ গ্রাম"; price = 950 }
  mariyam = @{ name = "মারিয়াম"; weight = "১ কেজি"; price = 690 }
}
$deliveryRates = @{ inside = 70; outside = 130 }
$allowedStatuses = @("নতুন", "নিশ্চিত", "প্রস্তুত", "পাঠানো হয়েছে", "সম্পন্ন", "বাতিল")
$rateLimits = @{}

function Write-Response {
  param(
    [System.Net.HttpListenerContext]$Context,
    [int]$StatusCode,
    [string]$ContentType,
    [byte[]]$Body
  )

  $response = $Context.Response
  $response.StatusCode = $StatusCode
  $response.ContentType = $ContentType
  $response.ContentLength64 = $Body.Length
  $response.Headers["X-Content-Type-Options"] = "nosniff"
  $response.Headers["X-Frame-Options"] = "DENY"
  $response.Headers["Referrer-Policy"] = "same-origin"
  $response.Headers["Cache-Control"] = "no-store"
  $response.OutputStream.Write($Body, 0, $Body.Length)
  $response.Close()
}

function Write-Json {
  param(
    [System.Net.HttpListenerContext]$Context,
    [int]$StatusCode,
    [object]$Value
  )

  $json = ConvertTo-Json -InputObject $Value -Depth 8 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  Write-Response -Context $Context -StatusCode $StatusCode -ContentType "application/json; charset=utf-8" -Body $bytes
}

function Read-JsonBody {
  param([System.Net.HttpListenerRequest]$Request)

  if ($Request.ContentLength64 -gt $maxBodyBytes) {
    throw "REQUEST_TOO_LARGE"
  }

  $memory = New-Object System.IO.MemoryStream
  $buffer = New-Object byte[] 4096
  try {
    while (($read = $Request.InputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
      if (($memory.Length + $read) -gt $maxBodyBytes) {
        throw "REQUEST_TOO_LARGE"
      }
      $memory.Write($buffer, 0, $read)
    }

    $raw = [System.Text.Encoding]::UTF8.GetString($memory.ToArray())
    return ConvertFrom-Json -InputObject $raw -ErrorAction Stop
  }
  finally {
    $memory.Dispose()
  }
}

function Get-Orders {
  if (-not (Test-Path -LiteralPath $ordersPath)) {
    return @()
  }

  $json = [System.IO.File]::ReadAllText($ordersPath, [System.Text.Encoding]::UTF8)
  if ([string]::IsNullOrWhiteSpace($json)) {
    return @()
  }

  $savedOrders = ConvertFrom-Json -InputObject $json -ErrorAction Stop
  return @($savedOrders)
}

function Save-Orders {
  param([object[]]$Orders)

  $json = ConvertTo-Json -InputObject @($Orders) -Depth 8
  $temporaryPath = "$ordersPath.tmp"
  [System.IO.File]::WriteAllText($temporaryPath, $json, (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $temporaryPath -Destination $ordersPath -Force
}

function Test-FixedTimeString {
  param(
    [string]$Candidate,
    [string]$Expected
  )

  $candidateBytes = [System.Text.Encoding]::UTF8.GetBytes($Candidate)
  $expectedBytes = [System.Text.Encoding]::UTF8.GetBytes($Expected)
  if ($null -eq $candidateBytes) { $candidateBytes = [byte[]]@() }
  if ($null -eq $expectedBytes) { $expectedBytes = [byte[]]@() }
  $difference = $candidateBytes.Length -bxor $expectedBytes.Length
  $length = [Math]::Max($candidateBytes.Length, $expectedBytes.Length)

  for ($index = 0; $index -lt $length; $index++) {
    $candidateByte = if ($index -lt $candidateBytes.Length) { $candidateBytes[$index] } else { 0 }
    $expectedByte = if ($index -lt $expectedBytes.Length) { $expectedBytes[$index] } else { 0 }
    $difference = $difference -bor ($candidateByte -bxor $expectedByte)
  }

  return $difference -eq 0
}

function Test-AdminAuthorization {
  param([System.Net.HttpListenerRequest]$Request)

  $header = $Request.Headers["Authorization"]
  if ([string]::IsNullOrWhiteSpace($header) -or -not $header.StartsWith("Basic ", [StringComparison]::OrdinalIgnoreCase)) {
    return $false
  }

  try {
    $encoded = $header.Substring(6).Trim()
    $decoded = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
    $separator = $decoded.IndexOf(":")
    if ($separator -lt 1) {
      return $false
    }

    $user = $decoded.Substring(0, $separator)
    $password = $decoded.Substring($separator + 1)
    $userMatches = Test-FixedTimeString -Candidate $user -Expected $adminUsername
    $passwordMatches = Test-FixedTimeString -Candidate $password -Expected $adminPassword
    return $userMatches -and $passwordMatches
  }
  catch {
    return $false
  }
}

function Test-SameOrigin {
  param([System.Net.HttpListenerRequest]$Request)

  $origin = $Request.Headers["Origin"]
  if ([string]::IsNullOrWhiteSpace($origin)) {
    return $true
  }

  return $origin -eq $Request.Url.GetLeftPart([System.UriPartial]::Authority)
}

function Test-JsonContentType {
  param([System.Net.HttpListenerRequest]$Request)

  return $Request.ContentType -match "^application/json(?:\s*;|$)"
}

function Read-TextFile {
  param([string]$Path)

  $bytes = [System.IO.File]::ReadAllBytes($Path)
  Write-Response -Context $script:currentContext -StatusCode 200 -ContentType "text/html; charset=utf-8" -Body $bytes
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/")

try {
  $listener.Start()
}
catch {
  throw "Could not start the local server on port $Port. Close the other app using that port and try again. $($_.Exception.Message)"
}

Write-Host ""
Write-Host "খেজুর ঘর order server চালু হয়েছে:" -ForegroundColor Green
Write-Host "  Landing page: http://127.0.0.1:$Port/"
Write-Host "  Admin orders: http://127.0.0.1:$Port/admin"
Write-Host "  Admin user:   $adminUsername"
Write-Host "বন্ধ করতে Ctrl+C চাপুন।"
Write-Host ""

try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $script:currentContext = $context
    try {
      $request = $context.Request
      $path = $request.Url.AbsolutePath
      $method = $request.HttpMethod.ToUpperInvariant()

      if ($method -eq "GET" -and ($path -eq "/" -or $path -eq "/index.html")) {
        Read-TextFile -Path (Join-Path $root "index.html")
        continue
      }

      if ($method -eq "GET" -and ($path -eq "/admin" -or $path -eq "/admin.html")) {
        Read-TextFile -Path (Join-Path $root "admin.html")
        continue
      }

      $imageFiles = @{
        "/images/dates-bowl.jpg" = "dates-bowl.jpg"
        "/images/ajwa-dates.jpg" = "ajwa-dates.jpg"
        "/images/date-fruits-duo.jpg" = "date-fruits-duo.jpg"
      }
      if ($method -eq "GET" -and $imageFiles.ContainsKey($path)) {
        $imagePath = Join-Path (Join-Path $root "wwwroot\images") $imageFiles[$path]
        if (-not (Test-Path -LiteralPath $imagePath)) {
          Write-Json -Context $context -StatusCode 404 -Value @{ error = "ছবিটি পাওয়া যায়নি।" }
          continue
        }
        Write-Response -Context $context -StatusCode 200 -ContentType "image/jpeg" -Body ([System.IO.File]::ReadAllBytes($imagePath))
        continue
      }

      if ($path -eq "/api/orders" -and $method -eq "POST") {
        if (-not (Test-SameOrigin -Request $request)) {
          Write-Json -Context $context -StatusCode 403 -Value @{ error = "এই request গ্রহণ করা যায়নি।" }
          continue
        }
        if (-not (Test-JsonContentType -Request $request)) {
          Write-Json -Context $context -StatusCode 415 -Value @{ error = "অর্ডারের তথ্য JSON হিসেবে পাঠান।" }
          continue
        }

        $ip = $request.RemoteEndPoint.Address.ToString()
        $now = [DateTimeOffset]::UtcNow
        if (-not $rateLimits.ContainsKey($ip) -or ($now - $rateLimits[$ip].startedAt).TotalMinutes -ge 10) {
          $rateLimits[$ip] = @{ startedAt = $now; count = 0 }
        }
        if ($rateLimits[$ip].count -ge 20) {
          Write-Json -Context $context -StatusCode 429 -Value @{ error = "অনেকবার চেষ্টা হয়েছে। কিছুক্ষণ পরে আবার চেষ্টা করুন।" }
          continue
        }
        $rateLimits[$ip].count++

        try {
          $payload = Read-JsonBody -Request $request
        }
        catch {
          $status = if ($_.Exception.Message -eq "REQUEST_TOO_LARGE") { 413 } else { 400 }
          $errorMessage = if ($status -eq 413) { "ফর্মের তথ্য অনেক বড়।" } else { "ফর্মের তথ্য পড়া যায়নি। আবার চেষ্টা করুন।" }
          Write-Json -Context $context -StatusCode $status -Value @{ error = $errorMessage }
          continue
        }

        $name = ([string]$payload.name).Trim()
        $phone = ([string]$payload.phone).Trim()
        $district = ([string]$payload.district).Trim()
        $address = ([string]$payload.address).Trim()
        $normalizedPhone = $phone
        for ($digit = 0; $digit -le 9; $digit++) {
          $bengaliDigit = [string][char]([int][char]"০" + $digit)
          $normalizedPhone = $normalizedPhone.Replace($bengaliDigit, [string]$digit)
        }
        $phoneDigits = [regex]::Replace($normalizedPhone, "[\s+().-]", "")
        $quantity = 0
        $quantityValid = [int]::TryParse([string]$payload.quantity, [ref]$quantity)
        $productKey = [string]$payload.product
        $delivery = [string]$payload.delivery
        $addonValid = $null -eq $payload.addon -or $payload.addon -is [bool]

        if ([string]::IsNullOrWhiteSpace($name) -or $name.Length -gt 100 -or
            $phoneDigits -notmatch "^[0-9]{7,16}$" -or
            [string]::IsNullOrWhiteSpace($district) -or $district.Length -gt 100 -or
            [string]::IsNullOrWhiteSpace($address) -or $address.Length -gt 500 -or
            -not $quantityValid -or $quantity -lt 1 -or $quantity -gt 5 -or
            -not $products.ContainsKey($productKey) -or
            -not $deliveryRates.ContainsKey($delivery) -or
            -not $addonValid) {
          Write-Json -Context $context -StatusCode 400 -Value @{ error = "নাম, ফোন, ঠিকানা, পণ্য ও পরিমাণ ঠিক করে আবার দিন।" }
          continue
        }

        $product = $products[$productKey]
        $addOn = $null -ne $payload.addon -and [bool]$payload.addon
        $shipping = [int]$deliveryRates[$delivery]
        $total = ([int]$product.price * $quantity) + $shipping
        if ($addOn) {
          $total += 190
        }

        $order = [ordered]@{
          id = [Guid]::NewGuid().ToString("N")
          createdAt = [DateTimeOffset]::UtcNow.ToString("o")
          name = $name
          phone = $phone
          district = $district
          address = $address
          product = $productKey
          productName = $product.name
          weight = $product.weight
          quantity = $quantity
          addon = $addOn
          delivery = $delivery
          deliveryCharge = $shipping
          total = $total
          status = "নতুন"
          updatedAt = $null
        }

        try {
          $orders = New-Object System.Collections.ArrayList
          foreach ($savedOrder in @(Get-Orders)) {
            [void]$orders.Add($savedOrder)
          }
          [void]$orders.Add([pscustomobject]$order)
          Save-Orders -Orders $orders.ToArray()
        }
        catch {
          Write-Warning "Could not save an order: $($_.Exception.Message)"
          Write-Json -Context $context -StatusCode 500 -Value @{ error = "অর্ডারটি সংরক্ষণ করা যায়নি। অনুগ্রহ করে আবার চেষ্টা করুন।" }
          continue
        }

        Write-Json -Context $context -StatusCode 201 -Value @{ id = $order.id; total = $total }
        continue
      }

      if ($path -like "/api/admin/orders*" -and $method -in @("GET", "PATCH")) {
        if (-not (Test-AdminAuthorization -Request $request)) {
          Write-Json -Context $context -StatusCode 401 -Value @{ error = "অ্যাডমিন ইউজারনেম বা পাসওয়ার্ড সঠিক নয়।" }
          continue
        }

        if ($method -eq "GET" -and $path -eq "/api/admin/orders") {
          $orders = @(Get-Orders | Sort-Object createdAt -Descending | Select-Object -First 200)
          Write-Json -Context $context -StatusCode 200 -Value @{ orders = $orders }
          continue
        }

        if ($method -eq "PATCH" -and $path -match "^/api/admin/orders/([a-fA-F0-9]{32})$") {
          if (-not (Test-JsonContentType -Request $request)) {
            Write-Json -Context $context -StatusCode 415 -Value @{ error = "নতুন status JSON হিসেবে পাঠান।" }
            continue
          }
          try {
            $payload = Read-JsonBody -Request $request
          }
          catch {
            Write-Json -Context $context -StatusCode 400 -Value @{ error = "নতুন status পড়া যায়নি।" }
            continue
          }

          $newStatus = [string]$payload.status
          if ($newStatus -notin $allowedStatuses) {
            Write-Json -Context $context -StatusCode 400 -Value @{ error = "এই status গ্রহণযোগ্য নয়।" }
            continue
          }

          $orders = New-Object System.Collections.ArrayList
          $found = $false
          foreach ($savedOrder in @(Get-Orders)) {
            if ($savedOrder.id -eq $Matches[1]) {
              $savedOrder.status = $newStatus
              $updatedAt = [DateTimeOffset]::UtcNow.ToString("o")
              if ($savedOrder.PSObject.Properties["updatedAt"]) {
                $savedOrder.updatedAt = $updatedAt
              }
              else {
                $savedOrder | Add-Member -NotePropertyName updatedAt -NotePropertyValue $updatedAt
              }
              $found = $true
            }
            [void]$orders.Add($savedOrder)
          }
          if (-not $found) {
            Write-Json -Context $context -StatusCode 404 -Value @{ error = "অর্ডারটি পাওয়া যায়নি।" }
            continue
          }
          Save-Orders -Orders $orders.ToArray()
          Write-Json -Context $context -StatusCode 200 -Value @{ status = $newStatus }
          continue
        }
      }

      Write-Json -Context $context -StatusCode 404 -Value @{ error = "পেজটি পাওয়া যায়নি।" }
    }
    catch {
      Write-Warning "Request failed: $($_.Exception.Message)"
      try {
        Write-Json -Context $context -StatusCode 500 -Value @{ error = "সার্ভারে সমস্যা হয়েছে। অনুগ্রহ করে আবার চেষ্টা করুন।" }
      }
      catch {
        $context.Response.Abort()
      }
    }
  }
}
finally {
  $listener.Stop()
  $listener.Close()
}

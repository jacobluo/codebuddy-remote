import AVFoundation
import SwiftUI
import UIKit

struct QRCodeScannerView: UIViewControllerRepresentable {
  let onScan: (String) -> Void
  let onError: (String) -> Void

  func makeUIViewController(context: Context) -> ScannerViewController {
    ScannerViewController(onScan: onScan, onError: onError)
  }

  func updateUIViewController(_ uiViewController: ScannerViewController, context: Context) {}
}

final class ScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
  private let onScan: (String) -> Void
  private let onError: (String) -> Void
  private let session = AVCaptureSession()
  private var previewLayer: AVCaptureVideoPreviewLayer?
  private var didScan = false

  init(onScan: @escaping (String) -> Void, onError: @escaping (String) -> Void) {
    self.onScan = onScan
    self.onError = onError
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) {
    nil
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    configureCamera()
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    previewLayer?.frame = view.bounds
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    if session.isRunning {
      session.stopRunning()
    }
  }

  private func configureCamera() {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
      startSession()
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
        DispatchQueue.main.async {
          granted ? self?.startSession() : self?.onError("没有相机权限")
        }
      }
    case .denied, .restricted:
      onError("没有相机权限")
    @unknown default:
      onError("无法访问相机")
    }
  }

  private func startSession() {
    guard let device = AVCaptureDevice.default(for: .video) else {
      onError("当前设备没有可用相机")
      return
    }

    do {
      let input = try AVCaptureDeviceInput(device: device)
      guard session.canAddInput(input) else {
        onError("无法启动相机输入")
        return
      }
      session.addInput(input)

      let output = AVCaptureMetadataOutput()
      guard session.canAddOutput(output) else {
        onError("无法启动二维码扫描")
        return
      }
      session.addOutput(output)
      output.setMetadataObjectsDelegate(self, queue: .main)
      output.metadataObjectTypes = [.qr]

      let layer = AVCaptureVideoPreviewLayer(session: session)
      layer.videoGravity = .resizeAspectFill
      layer.frame = view.bounds
      view.layer.insertSublayer(layer, at: 0)
      previewLayer = layer

      DispatchQueue.global(qos: .userInitiated).async { [session] in
        session.startRunning()
      }
    } catch {
      onError(error.localizedDescription)
    }
  }

  func metadataOutput(
    _ output: AVCaptureMetadataOutput,
    didOutput metadataObjects: [AVMetadataObject],
    from connection: AVCaptureConnection
  ) {
    guard
      !didScan,
      let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
      let value = object.stringValue
    else {
      return
    }

    didScan = true
    session.stopRunning()
    onScan(value)
  }
}
